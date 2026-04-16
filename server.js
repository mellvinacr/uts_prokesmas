const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const AWS = require('aws-sdk');
const path = require('path');
const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

// Konfigurasi AWS S3 - PASTI KAN NAMA DI DALAM process.env. SAMA DENGAN DI GITHUB SECRETS
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1' 
});

// Konfigurasi Database RDS
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER || 'admin', 
    password: process.env.DB_PASSWORD, // Nama variabel di GitHub Secrets
    database: process.env.DB_NAME || 'prokesmas_db'
});

const upload = multer({ dest: 'uploads/' });

// Route Tampilan Utama (Monitoring)
app.get('/', (req, res) => {
    db.query('SELECT * FROM laporan_kesehatan', (err, results) => {
        if (err) return res.status(500).send(err.message);
        res.render('index', { reports: results || [] });
    });
});

// Fitur 1 & 2: Laporan Lingkungan + Upload S3 (Wajib sesuai UTS) [cite: 42, 48]
app.post('/report', upload.single('photo'), (req, res) => {
    const { nama, deskripsi } = req.body;
    const file = req.file;

    if (!file) return res.status(400).send('Foto wajib diunggah');

    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `laporan_${Date.now()}${path.extname(file.originalname)}`,
        Body: require('fs').createReadStream(file.path),
        ACL: 'public-read' // Agar bisa diakses dosen di web [cite: 580, 581]
    };

    s3.upload(params, (err, data) => {
        if (err) return res.status(500).send(err.message);
        
        const query = 'INSERT INTO laporan_kesehatan (nama, deskripsi, foto_url) VALUES (?, ?, ?)';
        db.query(query, [nama, deskripsi, data.Location], (err) => {
            if (err) return res.status(500).send(err.message);
            res.redirect('/');
        });
    });
});

// Fitur 3: Booking Layanan (Fitur tambahan sesuai permintaanmu) [cite: 47]
app.post('/booking', (req, res) => {
    const { nama_pasien, layanan, tanggal } = req.body;
    db.query('INSERT INTO booking (nama, layanan, tanggal) VALUES (?, ?, ?)', 
    [nama_pasien, layanan, tanggal], (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/');
    });
});

// Port 80 wajib agar bisa diakses via IP Publik EC2 [cite: 39, 246]
app.listen(80, () => console.log('ProKesMas running on port 80'));