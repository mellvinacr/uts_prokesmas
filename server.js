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

// --- 1. KONFIGURASI SESSION ---
app.use(session({ 
    secret: 'prokesmas-secret-key-uts', 
    resave: false, 
    saveUninitialized: true 
}));

// --- 2. HELPER: HITUNG USIA ---
const getAge = (birthDate) => {
    if (!birthDate) return 0;
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
};

// --- 3. AWS S3 CONFIG ---
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' 
});

// --- 4. DATABASE RDS CONFIG ---
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'admin', 
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'prokesmas_db',
    waitForConnections: true,
    connectionLimit: 10
});

const upload = multer({ dest: 'uploads/' });

// --- 5. ROUTES ---

// A. Landing Page
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('login');
});

// B. Register
app.get('/register-page', (req, res) => res.render('register'));

app.post('/register', (req, res) => {
    const { username, password, nama, tgl_lahir, alamat } = req.body;
    db.query('INSERT INTO users (username, password, role) VALUES (?, ?, "pasien")', [username, password], (err, result) => {
        if (err) return res.status(500).send("Gagal Register: " + err.message);
        const userId = result.insertId;
        db.query('INSERT INTO profil_pasien (user_id, nama_lengkap, tgl_lahir, alamat) VALUES (?, ?, ?, ?)', 
        [userId, nama, tgl_lahir, alamat], (err) => {
            if (err) return res.status(500).send("Gagal Buat Profil: " + err.message);
            res.send("<script>alert('Registrasi Berhasil!'); window.location='/';</script>");
        });
    });
});

// C. Login
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username.trim(), password.trim()], (err, results) => {
        if (err) return res.status(500).send(err.message);
        if (results.length > 0) {
            req.session.user = results[0];
            res.redirect('/dashboard');
        } else {
            res.send("<script>alert('Login Gagal!'); window.location='/';</script>");
        }
    });
});

// D. Unified Dashboard (Pasien & Admin)
app.get('/dashboard', (req, res) => {
    const user = req.session.user;
    if (!user) return res.redirect('/');

    const qReports = 'SELECT * FROM laporan_kesehatan ORDER BY created_at DESC';
    const qBooking = "SELECT * FROM booking WHERE status != 'selesai' ORDER BY tanggal ASC";
    const qPasien = "SELECT u.id, p.nama_lengkap, p.tgl_lahir, p.alamat FROM users u JOIN profil_pasien p ON u.id = p.user_id";
    
    // Ambil rekam medis: Admin lihat semua, Pasien lihat milik sendiri
    const qMedis = user.role === 'admin' 
        ? "SELECT * FROM rekam_medis ORDER BY tanggal_periksa DESC" 
        : "SELECT * FROM rekam_medis WHERE pasien_id = ? ORDER BY tanggal_periksa DESC";

    db.query(qReports, (err, reports) => {
        db.query(qBooking, (err, bookings) => {
            db.query(qPasien, (err, pasiens) => {
                db.query(qMedis, [user.id], (err, medicalHistory) => {
                    const myProfile = pasiens.find(p => p.id === user.id);
                    res.render('index', { 
                        user, 
                        reports: reports || [], 
                        bookings: bookings || [], 
                        pasiens: pasiens || [], 
                        medicalHistory: medicalHistory || [],
                        myProfile: myProfile || null,
                        getAge,
                        newBookingCode: req.query.newCode || null 
                    });
                });
            });
        });
    });
});

// E. Fitur Rekam Medis (Admin)
app.post('/admin/rekam-medis', (req, res) => {
    const { pasien_id, diagnosis, obat } = req.body;
    // Menggunakan pasien_id (id user) agar sinkron dengan dashboard pasien
    const query = "INSERT INTO rekam_medis (pasien_id, diagnosis, obat) VALUES (?, ?, ?)";
    db.query(query, [pasien_id, diagnosis, obat], (err) => {
        if (err) return res.status(500).send("Gagal simpan rekam medis: " + err.message);
        // Redirect ke dashboard, bukan ke login ('/')
        res.send("<script>alert('Data Medis Berhasil Disimpan!'); window.location='/dashboard';</script>");
    });
});

// F. S3 Upload (Monitoring)
app.post('/report', upload.single('photo'), (req, res) => {
    const { nama, deskripsi } = req.body;
    const file = req.file;
    if (!file) return res.status(400).send('Foto wajib ada');

    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `laporan_${Date.now()}${path.extname(file.originalname)}`,
        Body: fs.createReadStream(file.path),
        ACL: 'public-read',
        ContentType: file.mimetype
    };

    s3.upload(params, (err, data) => {
        if (file) fs.unlinkSync(file.path);
        if (err) return res.status(500).send(err.message);
        db.query('INSERT INTO laporan_kesehatan (nama, deskripsi, foto_url) VALUES (?, ?, ?)', [nama, deskripsi, data.Location], (err) => {
            res.redirect('/dashboard');
        });
    });
});

// G. Booking & Update Status
app.post('/booking', (req, res) => {
    const { nama_pasien, layanan, tanggal } = req.body;
    const kode = `PKM-${nanoid()}`;
    db.query("INSERT INTO booking (nama_pasien, layanan, tanggal, kode_booking, status) VALUES (?, ?, ?, ?, 'menunggu')", 
    [nama_pasien, layanan, tanggal, kode], (err) => {
        res.redirect(`/dashboard?newCode=${kode}`);
    });
});

app.post('/admin/update-status/:kode', (req, res) => {
    const { kode } = req.params;
    const { status_baru } = req.body;
    db.query("UPDATE booking SET status = ? WHERE kode_booking = ?", [status_baru, kode], (err) => {
        res.redirect('/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Halaman Riwayat Rekam Medis Khusus Admin
app.get('/admin/history-medis', (req, res) => {
    const user = req.session.user;
    if (!user || user.role !== 'admin') return res.redirect('/');

    const query = `
        SELECT rm.*, p.nama_lengkap 
        FROM rekam_medis rm 
        JOIN profil_pasien p ON rm.pasien_id = p.user_id 
        ORDER BY rm.tanggal_periksa DESC`;

    db.query(query, (err, medicalHistory) => {
        if (err) return res.status(500).send(err.message);
        res.render('history-medis', { medicalHistory });
    });
});

// Update rute POST rekam medis agar redirect ke halaman history ini
app.post('/admin/rekam-medis', (req, res) => {
    const { pasien_id, diagnosis, obat } = req.body;
    const query = "INSERT INTO rekam_medis (pasien_id, diagnosis, obat) VALUES (?, ?, ?)";
    db.query(query, [pasien_id, diagnosis, obat], (err) => {
        if (err) return res.status(500).send(err.message);
        // REDIRECT KE HALAMAN HISTORY
        res.redirect('/admin/history-medis');
    });
});

app.listen(80, () => console.log('ProKesMas running on port 80'));