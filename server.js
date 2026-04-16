const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const AWS = require('aws-sdk');
const path = require('path');
const fs = require('fs');
const { customAlphabet } = require('nanoid');
const session = require('express-session');

const app = express();
const nanoid = customAlphabet('1234567890ABCDEF', 6);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

// --- KONFIGURASI SESSION ---
app.use(session({ 
    secret: 'prokesmas-secret-key', 
    resave: false, 
    saveUninitialized: true 
}));

// --- HELPER: HITUNG USIA ---
const getAge = (birthDate) => {
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
};

// --- AWS S3 CONFIG ---
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' 
});

// --- DATABASE RDS CONFIG ---
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'admin', 
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'prokesmas_db',
    waitForConnections: true,
    connectionLimit: 10
});

const upload = multer({ dest: 'uploads/' });

// --- ROUTES ---

// 1. Landing / Login Page
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('login');
});

// 2. Register Page & Logic
app.get('/register-page', (req, res) => {
    res.render('register');
});

app.post('/register', (req, res) => {
    const { username, password, nama, tgl_lahir, alamat } = req.body;
    db.query('INSERT INTO users (username, password, role) VALUES (?, ?, "pasien")', [username, password], (err, result) => {
        if (err) return res.status(500).send("Gagal Register User: " + err.message);
        const userId = result.insertId;
        db.query('INSERT INTO profil_pasien (user_id, nama_lengkap, tgl_lahir, alamat) VALUES (?, ?, ?, ?)', 
        [userId, nama, tgl_lahir, alamat], (err) => {
            if (err) return res.status(500).send("Gagal Buat Profil: " + err.message);
            res.redirect('/');
        });
    });
});

// 3. Login Logic
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err) return res.status(500).send(err.message);
        if (results.length > 0) {
            req.session.user = results[0];
            res.redirect('/dashboard');
        } else {
            res.send("<script>alert('Login Gagal! Akun tidak ditemukan.'); window.location='/';</script>");
        }
    });
});

// 4. Unified Dashboard
app.get('/dashboard', (req, res) => {
    const user = req.session.user;
    if (!user) return res.redirect('/');

    const qReports = 'SELECT * FROM laporan_kesehatan ORDER BY created_at DESC';
    const qBooking = "SELECT * FROM booking WHERE status = 'menunggu' ORDER BY tanggal ASC";
    const qPasien = "SELECT u.id, p.nama_lengkap, p.tgl_lahir, p.alamat FROM users u JOIN profil_pasien p ON u.id = p.user_id";

    db.query(qReports, (err, reports) => {
        db.query(qBooking, (err, bookings) => {
            db.query(qPasien, (err, pasiens) => {
                const myProfile = pasiens.find(p => p.id === user.id);
                res.render('index', { 
                    user, 
                    reports: reports || [], 
                    bookings: bookings || [], 
                    pasiens: pasiens || [], 
                    myProfile: myProfile || null,
                    getAge,
                    newBookingCode: req.query.newCode || null // Ambil kode dari query param jika ada
                });
            });
        });
    });
});

// 5. Booking Service (Pasien)
app.post('/booking', (req, res) => {
    const { nama_pasien, layanan, tanggal } = req.body;
    const kode_booking = `PKM-${nanoid()}`;
    const query = "INSERT INTO booking (nama_pasien, layanan, tanggal, kode_booking, status) VALUES (?, ?, ?, ?, 'menunggu')";
    
    db.query(query, [nama_pasien, layanan, tanggal, kode_booking], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect(`/dashboard?newCode=${kode_booking}`);
    });
});

// 6. Report Environment (Admin - S3)
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
        fs.unlinkSync(file.path); // Hapus file lokal
        if (err) return res.status(500).send(err.message);
        
        const query = 'INSERT INTO laporan_kesehatan (nama, deskripsi, foto_url) VALUES (?, ?, ?)';
        db.query(query, [nama, deskripsi, data.Location], (err) => {
            if (err) return res.status(500).send(err.message);
            res.redirect('/dashboard');
        });
    });
});

// 7. Input Rekam Medis (Admin)
app.post('/admin/rekam-medis', (req, res) => {
    const { pasien_nama, diagnosis, obat } = req.body;
    // Disini kita simpan ke tabel rekam_medis
    const query = "INSERT INTO rekam_medis (pasien_nama, diagnosis, obat) VALUES (?, ?, ?)";
    db.query(query, [pasien_nama, diagnosis, obat], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/dashboard');
    });
});

// 8. Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(80, () => console.log('ProKesMas running on port 80'));