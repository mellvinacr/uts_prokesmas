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

app.use(session({ 
    secret: 'prokesmas-secret-key-uts', 
    resave: false, 
    saveUninitialized: true 
}));

const getAge = (birthDate) => {
    if (!birthDate) return 0;
    const today = new Date();
    const birth = new Date(birthDate);
    if (isNaN(birth)) return 0;
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age < 0 ? 0 : age;
};

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' 
});

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'admin', 
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'prokesmas_db',
    waitForConnections: true,
    connectionLimit: 10
});

const upload = multer({ dest: 'uploads/' });

// --- ROUTE BERANDA (LANDING PAGE) ---
app.get('/', (req, res) => {
    const qCount = "SELECT COUNT(*) as total FROM booking WHERE status != 'selesai'";
    db.query(qCount, (err, results) => {
        const totalAntrean = results[0].total || 0;
        res.render('beranda', { totalAntrean }); 
    });
});

// --- ROUTE LOGIN & REGISTER PAGE ---
app.get('/login-page', (req, res) => res.render('login'));
app.get('/register-page', (req, res) => res.render('register'));

app.post('/register', (req, res) => {
    const { username, password, nama, tgl_lahir, alamat } = req.body;
    db.query('INSERT INTO users (username, password, role) VALUES (?, ?, "pasien")', [username, password], (err, result) => {
        if (err) return res.status(500).send("Gagal Register: " + err.message);
        const userId = result.insertId;
        db.query('INSERT INTO profil_pasien (user_id, nama_lengkap, tgl_lahir, alamat) VALUES (?, ?, ?, ?)', 
        [userId, nama, tgl_lahir, alamat], (err) => {
            if (err) return res.status(500).send("Gagal Profil: " + err.message);
            res.send("<script>alert('Registrasi Berhasil! Silakan Login.'); window.location='/login-page';</script>");
        });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username.trim(), password.trim()], (err, results) => {
        if (err) return res.status(500).send(err.message);
        if (results.length > 0) {
            req.session.user = results[0];
            res.redirect('/dashboard');
        } else {
            res.send("<script>alert('Login Gagal!'); window.location='/login-page';</script>");
        }
    });
});

app.get('/dashboard', (req, res) => {
    const user = req.session.user;
    if (!user) return res.redirect('/login-page');

    const qReports = 'SELECT * FROM laporan_kesehatan ORDER BY created_at DESC';
    const qBookingAdmin = "SELECT * FROM booking WHERE status != 'selesai' ORDER BY tanggal ASC";
    const qPasien = "SELECT u.id, p.nama_lengkap, p.tgl_lahir, p.alamat FROM users u JOIN profil_pasien p ON u.id = p.user_id";
    
    db.query(qReports, (err, reports) => {
        db.query(qBookingAdmin, (err, bookings) => {
            db.query(qPasien, (err, pasiens) => {
                const myProfile = pasiens.find(p => p.id === user.id);
                const qBookingPasien = "SELECT * FROM booking WHERE nama_pasien = ? ORDER BY tanggal DESC";
                
                db.query(qBookingPasien, [myProfile ? myProfile.nama_lengkap : ''], (err, myBookings) => {
                    const qMedis = user.role === 'admin' 
                        ? "SELECT rm.*, p.nama_lengkap FROM rekam_medis rm JOIN profil_pasien p ON rm.pasien_id = p.user_id ORDER BY rm.tanggal_periksa DESC" 
                        : "SELECT * FROM rekam_medis WHERE pasien_id = ? ORDER BY tanggal_periksa DESC";
                    
                    db.query(qMedis, [user.id], (err, medicalHistory) => {
                        res.render('index', { 
                            user, reports: reports || [], bookings: bookings || [], 
                            pasiens: pasiens || [], medicalHistory: medicalHistory || [],
                            myProfile: myProfile || null, getAge, myBookings: myBookings || [],
                            newBookingCode: req.query.newCode || null 
                        });
                    });
                });
            });
        });
    });
});

// --- S3 UPLOAD ---
app.post('/report', upload.single('photo'), (req, res) => {
    const { nama, deskripsi } = req.body;
    const file = req.file;
    if (!file) return res.status(400).send('File wajib diunggah');
    const ext = path.extname(file.originalname).toLowerCase();
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `laporan_${Date.now()}${ext}`,
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

app.get('/admin/history-medis', (req, res) => {
    const user = req.session.user;
    if (!user || user.role !== 'admin') return res.redirect('/login-page');
    const { filter_pasien } = req.query;
    let query = "SELECT rm.*, p.nama_lengkap FROM rekam_medis rm JOIN profil_pasien p ON rm.pasien_id = p.user_id";
    let params = [];
    if (filter_pasien && filter_pasien !== 'all') {
        query += " WHERE rm.pasien_id = ?";
        params.push(filter_pasien);
    }
    query += " ORDER BY rm.tanggal_periksa DESC";
    db.query(query, params, (err, medicalHistory) => {
        db.query("SELECT user_id as id, nama_lengkap FROM profil_pasien", (err, pasiens) => {
            res.render('history-medis', { medicalHistory, pasiens: pasiens || [], selectedPasien: filter_pasien || 'all' });
        });
    });
});

app.post('/admin/rekam-medis', (req, res) => {
    const { pasien_id, diagnosis, obat } = req.body;
    db.query("INSERT INTO rekam_medis (pasien_id, diagnosis, obat) VALUES (?, ?, ?)", [pasien_id, diagnosis, obat], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/admin/history-medis');
    });
});

// --- DELETE & UPDATE LAPORAN ---
app.post('/admin/delete-report/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM laporan_kesehatan WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/dashboard');
    });
});

app.post('/admin/update-report/:id', (req, res) => {
    const { id } = req.params;
    const { new_deskripsi } = req.body;
    db.query('UPDATE laporan_kesehatan SET deskripsi = ? WHERE id = ?', [new_deskripsi, id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(80, () => console.log('ProKesMas running on port 80'));