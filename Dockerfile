# Gunakan image Node.js versi terbaru
FROM node:18

# Tentukan direktori kerja di dalam kontainer
WORKDIR /usr/src/app

# Salin file package.json dan package-lock.json
COPY package*.json ./

# Instal semua dependencies aplikasi
RUN npm install

# Salin seluruh kode sumber aplikasi ke dalam kontainer
COPY . .

# Aplikasi kamu jalan di port 80 sesuai server.js
EXPOSE 80

# Perintah untuk menjalankan aplikasi
CMD [ "node", "server.js" ]