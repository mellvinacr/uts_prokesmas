const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const AWS = require('aws-sdk');
const path = require('path');
const fs = require('fs');
const { customAlphabet } = require('nanoid');
const session = require('express-session'); // Tambahkan ini di package.json

const app = express();
const nanoid = customAlphabet('1234567890ABCDEF', 6);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'prokesmas-secret', resave: false, saveUninitialized: true }));

// --- HELPER: HITUNG USIA ---
const getAge = (birthDate) => {
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
};

// --- AWS & DB CONFIG (Tetap Sama) ---
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' 
});

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'admin', 
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'prokesmas_db'
});

const upload = multer({ dest: 'uploads/' });

// --- ROUTES ---

// 1. Landing / Login Page
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('login'); // Buat file login.ejs terpisah
});

// 2. Register Pasien
app.post('/register', (req, res) => {
    const { username, password, nama, tgl_lahir, alamat } = req.body;
    db.query('INSERT INTO users (username, password, role) VALUES (?, ?, "pasien")', [username, password], (err, result) => {
        if (err) return res.status(500).send(err.message);
        const userId = result.insertId;
        db.query('INSERT INTO profil_pasien (user_id, nama_lengkap, tgl_lahir, alamat) VALUES (?, ?, ?, ?)', 
        [userId, nama, tgl_lahir, alamat], (err) => {
            res.redirect('/');
        });
    });
});

// 3. Login Logic
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (results.length > 0) {
            req.session.user = results[0];
            res.redirect('/dashboard');
        } else {
            res.send("Login Gagal!");
        }
    });
});

// 4. Unified Dashboard (Pasien & Admin)
app.get('/dashboard', (req, res) => {
    const user = req.session.user;
    if (!user) return res.redirect('/');

    const qReports = 'SELECT * FROM laporan_kesehatan ORDER BY created_at DESC';
    const qBooking = "SELECT * FROM booking ORDER BY tanggal ASC";
    const qPasien = "SELECT u.id, p.nama_lengkap, p.tgl_lahir, p.alamat FROM users u JOIN profil_pasien p ON u.id = p.user_id";

    db.query(qReports, (err, reports) => {
        db.query(qBooking, (err, bookings) => {
            db.query(qPasien, (err, pasiens) => {
                // Jika user adalah pasien, ambil profil spesifiknya
                const myProfile = pasiens.find(p => p.id === user.id);
                res.render('index', { 
                    user, 
                    reports, 
                    bookings, 
                    pasiens, 
                    myProfile,
                    getAge 
                });
            });
        });
    });
});

// 5. Admin CRUD: Update Rekam Medis
app.post('/admin/rekam-medis', (req, res) => {
    const { pasien_nama, diagnosis, tindakan, obat } = req.body;
    db.query('INSERT INTO rekam_medis (pasien_nama, diagnosis, tindakan, obat) VALUES (?, ?, ?, ?)', 
    [pasien_nama, diagnosis, tindakan, obat], (err) => {
        res.redirect('/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(80, () => console.log('ProKesMas running on port 80'));