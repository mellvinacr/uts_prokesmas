const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const AWS = require('aws-sdk');
const path = require('path');
const fs = require('fs');
const { customAlphabet } = require('nanoid');

const app = express();
const nanoid = customAlphabet('1234567890ABCDEF', 6);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Jika ada file static

// --- 1. KONFIGURASI AWS S3 ---
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' 
});

// --- 2. KONFIGURASI DATABASE RDS ---
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'admin', 
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'prokesmas_db',
    waitForConnections: true,
    connectionLimit: 10
});

const upload = multer({ dest: 'uploads/' });

// --- 3. ROUTE UTAMA (MONITORING + ADMIN VIEW) ---
app.get('/', (req, res) => {
    // Ambil data Laporan & Booking sekaligus menggunakan Promise atau Nesting
    const qLaporan = 'SELECT * FROM laporan_kesehatan ORDER BY created_at DESC';
    const qBooking = "SELECT * FROM booking WHERE status = 'menunggu' ORDER BY tanggal ASC";

    db.query(qLaporan, (err, reports) => {
        if (err) return res.status(500).send("Gagal ambil laporan: " + err.message);
        
        db.query(qBooking, (err, bookings) => {
            if (err) return res.status(500).send("Gagal ambil data booking: " + err.message);
            
            res.render('index', { 
                reports: reports || [], 
                bookings: bookings || [],
                newBookingCode: null // Default null saat pertama akses
            });
        });
    });
});

// --- 4. FITUR: LAPORAN LINGKUNGAN + S3 ---
app.post('/report', upload.single('photo'), (req, res) => {
    const { nama, deskripsi } = req.body;
    const file = req.file;

    if (!file) return res.status(400).send('Foto wajib diunggah');

    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `laporan_${Date.now()}${path.extname(file.originalname)}`,
        Body: fs.createReadStream(file.path),
        ACL: 'public-read',
        ContentType: file.mimetype
    };

    s3.upload(params, (err, data) => {
        // Hapus file temporary di lokal setelah upload ke S3
        fs.unlinkSync(file.path);

        if (err) return res.status(500).send("S3 Upload Error: " + err.message);
        
        const query = 'INSERT INTO laporan_kesehatan (nama, deskripsi, foto_url) VALUES (?, ?, ?)';
        db.query(query, [nama, deskripsi, data.Location], (err) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.redirect('/');
        });
    });
});

// --- 5. FITUR: BOOKING LAYANAN (KODE BARCODE) ---
app.post('/booking', (req, res) => {
    const { nama_pasien, layanan, tanggal } = req.body;
    const kode_booking = `PKM-${nanoid()}`;

    const query = "INSERT INTO booking (nama_pasien, layanan, tanggal, kode_booking, status) VALUES (?, ?, ?, ?, 'menunggu')";
    
    db.query(query, [nama_pasien, layanan, tanggal, kode_booking], (err) => {
        if (err) return res.status(500).send("Booking Error: " + err.message);
        
        // Ambil data lagi untuk re-render dengan Barcode
        const qLaporan = 'SELECT * FROM laporan_kesehatan ORDER BY created_at DESC';
        const qBooking = "SELECT * FROM booking WHERE status = 'menunggu' ORDER BY tanggal ASC";

        db.query(qLaporan, (err, reports) => {
            db.query(qBooking, (err, bookings) => {
                res.render('index', { 
                    reports: reports || [], 
                    bookings: bookings || [],
                    newBookingCode: kode_booking // Menampilkan Barcode di Client
                });
            });
        });
    });
});

// --- 6. FITUR: REKAM MEDIS (SIMULASI ADMIN) ---
app.post('/rekam-medis', (req, res) => {
    const { pasien_nama, diagnosis, tindakan, obat } = req.body;
    const query = "INSERT INTO rekam_medis (pasien_nama, diagnosis, tindakan, obat) VALUES (?, ?, ?, ?)";
    
    db.query(query, [pasien_nama, diagnosis, tindakan, obat], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/');
    });
});

// Port 80 wajib agar bisa diakses via IP Publik EC2
app.listen(80, () => console.log('ProKesMas running on port 80'));