// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const cheerio = require('cheerio');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const AYAT_FILE = path.join(__dirname, 'ayat.json');
const ADMIN_PASSWORD = '123456';

// Initialize OpenAI (akan menggunakan OPENAI_API_KEY dari environment variable)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || ''
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Middleware untuk memeriksa autentikasi admin (untuk HTML page)
const checkAdminAuth = (req, res, next) => {
  const pass = req.query.pass;
  
  if (pass === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Akses Ditolak - Admin Ayat Profetik</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css"
          integrity="sha512-wnea99uKIC3TJF7v4eKk4Y+lMz2Mklv18+r4na2Gn1abDRPPOeef95xTzdwGD9e6zXJBteMIhZ1+68QC5byJZw=="
          crossorigin="anonymous" referrerpolicy="no-referrer" />
      </head>
      <body class="bg-gray-100 min-h-screen flex items-center justify-center">
        <div class="bg-white rounded-lg shadow-md p-8 max-w-md w-full">
          <h1 class="text-2xl font-bold text-gray-800 mb-4 text-center">Akses Ditolak</h1>
          <p class="text-gray-600 mb-6 text-center">Halaman ini memerlukan autentikasi. Silakan masukkan password yang benar.</p>
        </div>
      </body>
      </html>
    `);
  }
};

// Middleware untuk memeriksa autentikasi admin (untuk API routes)
const checkAdminAuthAPI = (req, res, next) => {
  const pass = req.query.pass;
  
  if (pass === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({ error: 'Akses ditolak. Password diperlukan.' });
  }
};

// Helper functions untuk membaca dan menulis file
const readAyat = () => {
  try {
    const data = fs.readFileSync(AYAT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading ayat.json:', error);
    return [];
  }
};

const writeAyat = (data) => {
  try {
    fs.writeFileSync(AYAT_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing ayat.json:', error);
    return false;
  }
};

// Helper function untuk parse lokasi ayat (contoh: "Matius 5:16" -> {book: "matius", chapter: 5, verse: 16})
const parseAyatLocation = (lokasi) => {
  // Normalize: ubah ke lowercase, trim, dan normalisasi spasi
  let normalized = lokasi.toLowerCase().trim();
  
  // Hapus spasi sebelum dan sesudah colon, dash, atau comma
  normalized = normalized.replace(/\s*[:,-]\s*/g, (match) => {
    if (match.includes(':')) return ':';
    if (match.includes(',')) return ',';
    if (match.includes('-')) return '-';
    return match.trim();
  });
  
  // Hapus multiple spaces menjadi single space
  normalized = normalized.replace(/\s+/g, ' ');
  
  // Pattern: "kitab pasal:ayat-ayat" (range) - HARUS dicek DULU sebelum single verse
  // Handle: "Efesus 3:16-17", "Matius 5:16-18", "1 Korintus 13:4-7", "Mazmur 119 : 105 - 107"
  const rangeMatch = normalized.match(/^([1-3]?\s*[a-z]+)\s+(\d+):(\d+)[-–](\d+)/);
  if (rangeMatch) {
    const bookName = rangeMatch[1].trim().replace(/\s+/g, ''); // Hapus semua spasi
    return {
      book: bookName,
      chapter: parseInt(rangeMatch[2], 10),
      verse: parseInt(rangeMatch[3], 10),
      verseEnd: parseInt(rangeMatch[4], 10)
    };
  }
  
  // Pattern: "kitab pasal:ayat" atau "kitab pasal-ayat" (single verse)
  // Handle: "1 Korintus 5:16", "Matius 5:16", "1korintus 5:16", "Efesus 3:16", "Mazmur 143: 8", "Mazmur 119 : 105"
  const match = normalized.match(/^([1-3]?\s*[a-z]+)\s+(\d+)[:,-](\d+)/);
  if (match) {
    const bookName = match[1].trim().replace(/\s+/g, ''); // Hapus semua spasi
    return {
      book: bookName,
      chapter: parseInt(match[2], 10),
      verse: parseInt(match[3], 10)
    };
  }
  
  return null;
};

// Helper function untuk menormalisasi format lokasi ayat
const normalizeLokasiAyat = (lokasi) => {
  // Normalize: trim dan normalisasi spasi
  let normalized = lokasi.trim();
  
  // Hapus spasi sebelum dan sesudah colon, dash, atau comma
  normalized = normalized.replace(/\s*[:,-]\s*/g, (match) => {
    if (match.includes(':')) return ':';
    if (match.includes(',')) return ',';
    if (match.includes('-')) return '-';
    return match.trim();
  });
  
  // Hapus multiple spaces menjadi single space (hanya untuk spasi antara kata)
  normalized = normalized.replace(/\s+/g, ' ');
  
  return normalized;
};

// Mapping nama kitab Indonesia ke format alkitab.mobi
const bookMapping = {
  'kejadian': 'genesis', 'kej': 'genesis', 'genesis': 'genesis',
  'keluaran': 'exodus', 'kel': 'exodus', 'exodus': 'exodus',
  'imamat': 'leviticus', 'im': 'leviticus', 'leviticus': 'leviticus',
  'bilangan': 'numbers', 'bil': 'numbers', 'numbers': 'numbers',
  'ulangan': 'deuteronomy', 'ul': 'deuteronomy', 'deuteronomy': 'deuteronomy',
  'yosua': 'joshua', 'yos': 'joshua', 'joshua': 'joshua',
  'hakim-hakim': 'judges', 'hak': 'judges', 'judges': 'judges',
  'rut': 'ruth', 'ruth': 'ruth',
  '1samuel': '1samuel', '1sam': '1samuel',
  '2samuel': '2samuel', '2sam': '2samuel',
  '1raja-raja': '1kings', '1raj': '1kings', '1kings': '1kings',
  '2raja-raja': '2kings', '2raj': '2kings', '2kings': '2kings',
  '1tawarikh': '1chronicles', '1taw': '1chronicles', '1chronicles': '1chronicles',
  '2tawarikh': '2chronicles', '2taw': '2chronicles', '2chronicles': '2chronicles',
  'ezra': 'ezra',
  'nehemia': 'nehemiah', 'neh': 'nehemiah', 'nehemiah': 'nehemiah',
  'ester': 'esther', 'est': 'esther', 'esther': 'esther',
  'ayub': 'job', 'job': 'job',
  'mazmur': 'psalms', 'mzm': 'psalms', 'maz': 'psalms', 'psalms': 'psalms',
  'amsal': 'proverbs', 'ams': 'proverbs', 'proverbs': 'proverbs',
  'pengkhotbah': 'ecclesiastes', 'pkh': 'ecclesiastes', 'ecclesiastes': 'ecclesiastes',
  'kidungagung': 'songofsongs', 'kid': 'songofsongs', 'songofsongs': 'songofsongs',
  'yesaya': 'isaiah', 'yes': 'isaiah', 'isaiah': 'isaiah',
  'yeremia': 'jeremiah', 'yer': 'jeremiah', 'jeremiah': 'jeremiah',
  'ratapan': 'lamentations', 'rat': 'lamentations', 'lamentations': 'lamentations',
  'yehezkiel': 'ezekiel', 'yeh': 'ezekiel', 'ezekiel': 'ezekiel',
  'daniel': 'daniel', 'dan': 'daniel',
  'hosea': 'hosea', 'hos': 'hosea',
  'yoel': 'joel', 'joel': 'joel',
  'amos': 'amos',
  'obaja': 'obadiah', 'ob': 'obadiah', 'obadiah': 'obadiah',
  'yunus': 'jonah', 'yon': 'jonah', 'jonah': 'jonah',
  'mikha': 'micah', 'mi': 'micah', 'micah': 'micah',
  'nahum': 'nahum', 'nah': 'nahum',
  'habakuk': 'habakkuk', 'hab': 'habakkuk', 'habakkuk': 'habakkuk',
  'zefanya': 'zephaniah', 'zef': 'zephaniah', 'zephaniah': 'zephaniah',
  'hagai': 'haggai', 'hag': 'haggai', 'haggai': 'haggai',
  'zakharia': 'zechariah', 'zak': 'zechariah', 'zechariah': 'zechariah',
  'maleakhi': 'malachi', 'mal': 'malachi', 'malachi': 'malachi',
  'matius': 'matthew', 'mat': 'matthew', 'matthew': 'matthew',
  'markus': 'mark', 'mark': 'mark',
  'lukas': 'luke', 'luk': 'luke', 'luke': 'luke',
  'yohanes': 'john', 'yoh': 'john', 'john': 'john',
  'kisahpararasul': 'acts', 'kis': 'acts', 'kisah': 'acts', 'acts': 'acts',
  'roma': 'romans', 'rom': 'romans', 'romans': 'romans',
  '1korintus': '1corinthians', '1kor': '1corinthians', '1corinthians': '1corinthians',
  '2korintus': '2corinthians', '2kor': '2corinthians', '2corinthians': '2corinthians',
  'galatia': 'galatians', 'gal': 'galatians', 'galatians': 'galatians',
  'efesus': 'ephesians', 'ef': 'ephesians', 'ephesians': 'ephesians',
  'filipi': 'philippians', 'flp': 'philippians', 'philippians': 'philippians',
  'kolose': 'colossians', 'kol': 'colossians', 'colossians': 'colossians',
  '1tesalonika': '1thessalonians', '1tes': '1thessalonians', '1thessalonians': '1thessalonians',
  '2tesalonika': '2thessalonians', '2tes': '2thessalonians', '2thessalonians': '2thessalonians',
  '1timotius': '1timothy', '1tim': '1timothy', '1timothy': '1timothy',
  '2timotius': '2timothy', '2tim': '2timothy', '2timothy': '2timothy',
  'titus': 'titus',
  'filemon': 'philemon', 'flm': 'philemon', 'philemon': 'philemon',
  'ibrani': 'hebrews', 'ibr': 'hebrews', 'hebrews': 'hebrews',
  'yakobus': 'james', 'yak': 'james', 'james': 'james',
  '1petrus': '1peter', '1pet': '1peter', '1peter': '1peter',
  '2petrus': '2peter', '2pet': '2peter', '2peter': '2peter',
  '1yohanes': '1john', '1yoh': '1john', '1john': '1john',
  '2yohanes': '2john', '2yoh': '2john', '2john': '2john',
  '3yohanes': '3john', '3yoh': '3john', '3john': '3john',
  'yudas': 'jude', 'jude': 'jude',
  'wahyu': 'revelation', 'why': 'revelation', 'revelation': 'revelation'
};

// Fungsi untuk mengambil ayat dari alkitab.mobi
const getAyatFromAlkitabMobi = async (lokasi) => {
  try {
    const parsed = parseAyatLocation(lokasi);
    if (!parsed) {
      throw new Error('Format lokasi ayat tidak valid');
    }

    const book = bookMapping[parsed.book];
    if (!book) {
      throw new Error(`Kitab "${parsed.book}" tidak ditemukan`);
    }

    const version = 'tb'; // Terjemahan Baru
    const url = `http://alkitab.mobi/${version}/${book}/${parsed.chapter}`;

    console.log(url);
    
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    
    let verses = [];
    
    // Cari semua paragraf dalam passage-text
    $('#passage-text p, .passage p').each((i, el) => {
      const $el = $(el);
      
      // Skip jika hidden, loading, atau error
      if ($el.attr('hidden') === 'hidden' || $el.hasClass('loading') || $el.hasClass('error')) {
        return;
      }
      
      // Skip paragraphtitle (judul paragraf) - baik yang ada di dalam atau seluruh paragraph adalah paragraphtitle
      if ($el.find('.paragraphtitle').length > 0 || $el.hasClass('paragraphtitle')) {
        return;
      }
      
      // Skip paragraph kosong
      if ($el.text().trim() === '') {
        return;
      }
      
      // Cari reftext untuk mendapatkan nomor ayat
      const $reftext = $el.find('.reftext');
      if ($reftext.length === 0) {
        return; // Skip jika tidak ada reftext
      }
      
      // Ambil nomor ayat dari anchor name (v1, v2, dll) atau dari link text
      let verse = 0;
      const $anchor = $reftext.find('a[name^="v"]');
      if ($anchor.length > 0) {
        const nameAttr = $anchor.attr('name');
        if (nameAttr && nameAttr.startsWith('v')) {
          verse = parseInt(nameAttr.substring(1), 10);
        }
      }
      
      // Jika tidak ketemu dari anchor, coba dari text reftext
      if (!verse) {
        const verseText = $reftext.text().trim();
        const verseMatch = verseText.match(/\d+/);
        if (verseMatch) {
          verse = parseInt(verseMatch[0], 10);
        }
      }
      
      if (!verse) {
        return; // Skip jika tidak ada nomor ayat
      }
      
      // Ambil teks ayat - HANYA dari span dengan data-begin atau speaking/after-speaking
      // JANGAN ambil semua text karena bisa mengandung paragraphtitle
      let textContent = '';
      
      // Prioritas 1: Ambil dari span dengan data-begin (ini adalah konten ayat sebenarnya)
      const $dataBegin = $el.find('[data-begin]');
      if ($dataBegin.length > 0) {
        // Ambil semua text dari semua span data-begin dalam paragraph ini saja
        textContent = $dataBegin.map((i, el) => {
          return $(el).text().trim();
        }).get().filter(t => t.length > 0).join(' ').trim();
      }
      
      // Prioritas 2: Jika tidak ada data-begin, ambil dari span speaking atau after-speaking
      if (!textContent) {
        const $speaking = $el.find('.speaking, .after-speaking');
        if ($speaking.length > 0) {
          textContent = $speaking.map((i, el) => {
            return $(el).text().trim();
          }).get().filter(t => t.length > 0).join(' ').trim();
        }
      }
      
      // Jika masih tidak ada konten dari span spesifik, skip (jangan ambil semua text)
      if (!textContent) {
        return; // Skip paragraph ini karena tidak ada konten ayat yang valid
      }
      
      // Pastikan tidak mengandung paragraphtitle atau judul lainnya (safety check)
      const textLower = textContent.toLowerCase();
      const forbiddenTexts = [
        'dipilih untuk diselamatkan',
        'kedurhakaan sebelum kedatangan tuhan',
        'paragraphtitle',
        'before-speaking'
      ];
      
      if (forbiddenTexts.some(forbidden => textLower.includes(forbidden))) {
        return; // Skip jika masih mengandung teks yang tidak diinginkan
      }
      
      // Bersihkan textContent dari whitespace berlebihan
      textContent = textContent.replace(/\s+/g, ' ').trim();
      
      if (textContent) {
        verses.push({
          verse,
          content: textContent
        });
      }
    });
    
    // Filter berdasarkan verse yang diminta
    let result = '';
    if (parsed.verseEnd) {
      // Range ayat (contoh: 3:16-17, 5:16-18)
      const relevantVerses = verses
        .filter(v => v.verse >= parsed.verse && v.verse <= parsed.verseEnd)
        .sort((a, b) => a.verse - b.verse); // Urutkan berdasarkan nomor ayat
      
      if (relevantVerses.length === 0) {
        throw new Error(`Ayat ${parsed.verse}-${parsed.verseEnd} tidak ditemukan`);
      }
      
      // Gabungkan semua ayat dengan spasi
      result = relevantVerses.map(v => v.content).join(' ');
    } else {
      // Single verse
      const verseData = verses.find(v => v.verse === parsed.verse);
      if (verseData) {
        result = verseData.content;
      } else {
        throw new Error(`Ayat ${parsed.verse} tidak ditemukan`);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error fetching from alkitab.mobi:', error);
    throw error;
  }
};

// Routes

// Admin route dengan autentikasi
app.get('/admin', checkAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// API Routes

// GET semua ayat (public, tidak perlu auth)
app.get('/api/ayat', (req, res) => {
  const ayat = readAyat();
  res.json(ayat);
});

// GET ayat random
app.get('/api/ayat/random', (req, res) => {
  const ayat = readAyat();
  
  if (ayat.length === 0) {
    return res.status(404).json({ error: 'Tidak ada ayat tersedia' });
  }
  
  // Generate seed berdasarkan waktu (menit dan detik)
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const seed = minutes * 1000 + seconds;
  
  // Seeded random function
  const seededRandom = (seed) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  };
  
  // Pilih random ayat berdasarkan seed
  const randomNum = Math.floor(seededRandom(seed) * ayat.length);
  const randomAyat = ayat[randomNum];
  
  res.json({
    lokasi: randomAyat[0],
    teks: randomAyat[1]
  });
});

// GET ayat by id
app.get('/api/ayat/:id', (req, res) => {
  const ayat = readAyat();
  const id = parseInt(req.params.id);
  
  if (id >= 0 && id < ayat.length) {
    res.json(ayat[id]);
  } else {
    res.status(404).json({ error: 'Ayat tidak ditemukan' });
  }
});

// CREATE ayat baru (memerlukan auth)
app.post('/api/ayat', checkAdminAuthAPI, (req, res) => {
  const { lokasi, teks } = req.body;
  
  if (!lokasi || !teks) {
    return res.status(400).json({ error: 'Lokasi dan teks ayat harus diisi' });
  }
  
  const ayat = readAyat();
  const newAyat = [lokasi, teks];
  ayat.push(newAyat);
  
  if (writeAyat(ayat)) {
    res.status(201).json({ message: 'Ayat berhasil ditambahkan', data: newAyat });
  } else {
    res.status(500).json({ error: 'Gagal menyimpan ayat' });
  }
});

// UPDATE ayat (memerlukan auth)
app.put('/api/ayat/:id', checkAdminAuthAPI, (req, res) => {
  const id = parseInt(req.params.id);
  const { lokasi, teks } = req.body;
  
  if (!lokasi || !teks) {
    return res.status(400).json({ error: 'Lokasi dan teks ayat harus diisi' });
  }
  
  const ayat = readAyat();
  
  if (id >= 0 && id < ayat.length) {
    ayat[id] = [lokasi, teks];
    
    if (writeAyat(ayat)) {
      res.json({ message: 'Ayat berhasil diupdate', data: ayat[id] });
    } else {
      res.status(500).json({ error: 'Gagal menyimpan ayat' });
    }
  } else {
    res.status(404).json({ error: 'Ayat tidak ditemukan' });
  }
});

// DELETE ayat (memerlukan auth)
app.delete('/api/ayat/:id', checkAdminAuthAPI, (req, res) => {
  const id = parseInt(req.params.id);
  const ayat = readAyat();
  
  if (id >= 0 && id < ayat.length) {
    const deletedAyat = ayat.splice(id, 1);
    
    if (writeAyat(ayat)) {
      res.json({ message: 'Ayat berhasil dihapus', data: deletedAyat[0] });
    } else {
      res.status(500).json({ error: 'Gagal menghapus ayat' });
    }
  } else {
    res.status(404).json({ error: 'Ayat tidak ditemukan' });
  }
});

// Analisis ayat dengan ChatGPT AI (memerlukan auth)
app.post('/api/ayat/analyze', checkAdminAuthAPI, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY tidak dikonfigurasi. Silakan set environment variable OPENAI_API_KEY.' });
  }

  try {
    const ayat = readAyat();
    
    if (ayat.length === 0) {
      return res.status(400).json({ error: 'Tidak ada ayat untuk dianalisis' });
    }

    // Buat prompt untuk ChatGPT
    const ayatText = ayat.slice(0, 50).map((a, idx) => `${idx + 1}. [${a[0]}] ${a[1]}`).join('\n');
    
    const prompt = `Analisislah ayat-ayat Alkitab berikut dan berikan respons JSON dengan format:
{
  "toRemove": [indeks ayat yang bukan profetik (0-based)]
}

Ayat profetik adalah ayat yang mengandung janji Tuhan, nubuat, penggenapan, visi masa depan, atau harapan dari Tuhan. Ayat yang bukan profetik seperti perintah, larangan, cerita sejarah, atau pengajaran umum harus dihapus.

Ayat-ayat untuk dianalisis:
${ayatText}

Berikan hanya JSON response dengan array toRemove yang berisi indeks (0-based) ayat yang harus dihapus, tanpa penjelasan tambahan.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Kamu adalah ahli Alkitab yang mengkhususkan diri pada ayat-ayat profetik. Berikan respons hanya dalam format JSON yang diminta."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    const responseText = completion.choices[0].message.content.trim();
    
    // Parse JSON response
    let analysisResult;
    try {
      // Hapus markdown code block jika ada
      const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysisResult = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error('Error parsing ChatGPT response:', responseText);
      return res.status(500).json({ 
        error: 'Gagal memparse respons ChatGPT',
        rawResponse: responseText 
      });
    }

    // Proses hasil analisis - hanya hapus ayat yang tidak profetik
    const newAyat = [...ayat];
    let removedCount = 0;

    // Hapus ayat yang tidak profetik (dari belakang agar index tidak berubah)
    if (analysisResult.toRemove && Array.isArray(analysisResult.toRemove)) {
      const indicesToRemove = [...new Set(analysisResult.toRemove)].sort((a, b) => b - a);
      indicesToRemove.forEach(idx => {
        if (idx >= 0 && idx < newAyat.length) {
          newAyat.splice(idx, 1);
          removedCount++;
        }
      });
    }

    // Simpan perubahan
    if (writeAyat(newAyat)) {
      res.json({
        message: 'Analisis selesai',
        removed: removedCount,
        total: newAyat.length,
        details: {
          removedIndices: analysisResult.toRemove || []
        }
      });
    } else {
      res.status(500).json({ error: 'Gagal menyimpan perubahan' });
    }

  } catch (error) {
    console.error('Error in ChatGPT analysis:', error);
    res.status(500).json({ 
      error: 'Error saat menganalisis ayat',
      details: error.message 
    });
  }
});

// Generate ayat profetik baru dengan ChatGPT (memerlukan auth)
app.post('/api/ayat/generate', checkAdminAuthAPI, async (req, res) => {
  const { count = 5 } = req.body;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY tidak dikonfigurasi. Silakan set environment variable OPENAI_API_KEY.' });
  }

  try {
    const prompt = `Generate ${count} ayat profetik Alkitab yang kuat dan relevan. 
Berikan respons dalam format JSON:
{
  "ayat": [
    {"lokasi": "nama kitab pasal:ayat", "teks": "teks ayat profetik lengkap"}
  ]
}

Ayat harus:
- Otentik dari Alkitab (bukan dibuat-buat)
- Mengandung janji Tuhan, nubuat, atau harapan profetik
- Relevan untuk kehidupan modern
- Memberikan pengharapan dan kekuatan

Berikan hanya JSON, tanpa penjelasan.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Kamu adalah ahli Alkitab. Berikan hanya ayat-ayat Alkitab yang otentik dalam format JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });

    const responseText = completion.choices[0].message.content.trim();
    const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(cleanJson);

    if (result.ayat && Array.isArray(result.ayat)) {
      res.json({
        message: `Berhasil generate ${result.ayat.length} ayat profetik`,
        ayat: result.ayat
      });
    } else {
      res.status(500).json({ error: 'Format respons tidak valid' });
    }

  } catch (error) {
    console.error('Error generating ayat:', error);
    res.status(500).json({ 
      error: 'Error saat generate ayat',
      details: error.message 
    });
  }
});

// Repair ayat dari alkitab.mobi (memerlukan auth)
app.post('/api/ayat/repair', checkAdminAuthAPI, async (req, res) => {
  const { lokasi, id } = req.body;
  
  if (!lokasi) {
    return res.status(400).json({ error: 'Lokasi ayat harus diisi' });
  }

  try {
    // Normalisasi lokasi ayat terlebih dahulu
    const normalizedLokasi = normalizeLokasiAyat(lokasi);
    
    // Ambil teks ayat dari alkitab.mobi
    const teksAyat = await getAyatFromAlkitabMobi(normalizedLokasi);
    
    if (id !== undefined && id !== null) {
      // Update ayat yang ada
      const ayat = readAyat();
      const ayatId = parseInt(id);
      
        if (ayatId >= 0 && ayatId < ayat.length) {
          ayat[ayatId] = [normalizedLokasi, teksAyat];
        
        if (writeAyat(ayat)) {
          res.json({
            message: 'Ayat berhasil diperbaiki',
            lokasi,
            teks: teksAyat
          });
        } else {
          res.status(500).json({ error: 'Gagal menyimpan ayat' });
        }
      } else {
        res.status(404).json({ error: 'Ayat tidak ditemukan' });
      }
    } else {
      // Hanya return teks untuk preview (tidak save)
      res.json({
        message: 'Ayat berhasil diambil dari alkitab.mobi',
        lokasi: normalizedLokasi,
        teks: teksAyat
      });
    }
  } catch (error) {
    console.error('Error repairing ayat:', error);
    res.status(500).json({ 
      error: 'Error saat memperbaiki ayat',
      details: error.message 
    });
  }
});

// Repair all ayat dari alkitab.mobi (memerlukan auth)
app.post('/api/ayat/repair-all', checkAdminAuthAPI, async (req, res) => {
  try {
    const ayat = readAyat();
    
    if (ayat.length === 0) {
      return res.status(400).json({ error: 'Tidak ada ayat untuk diperbaiki' });
    }

    const results = {
      total: ayat.length,
      success: 0,
      failed: 0,
      removed: 0,
      errors: []
    };

    // Loop melalui semua ayat dan repair satu per satu (dari belakang untuk menghindari index shift)
    for (let i = ayat.length - 1; i >= 0; i--) {
      const [lokasi, currentTeks] = ayat[i];
      
      try {
        // Normalisasi lokasi ayat terlebih dahulu
        const normalizedLokasi = normalizeLokasiAyat(lokasi);
        
        // Ambil teks baru dari alkitab.mobi
        const newTeks = await getAyatFromAlkitabMobi(normalizedLokasi);
        
        // Update ayat dengan lokasi yang sudah dinormalisasi dan teks baru
        ayat[i] = [normalizedLokasi, newTeks];
        results.success++;
        
        // Tambahkan delay kecil untuk menghindari rate limiting
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
        }
      } catch (error) {
        console.error(`Error repairing ayat ${i} (${lokasi}):`, error.message);
        
        // Jika error adalah "Format lokasi ayat tidak valid", hapus ayat tersebut
        if (error.message.includes('Format lokasi ayat tidak valid')) {
          ayat.splice(i, 1); // Hapus ayat dari array
          results.removed++;
          results.errors.push({
            index: i,
            lokasi,
            error: error.message,
            action: 'removed'
          });
        } else {
          // Untuk error lain, tetap simpan tapi catat sebagai failed
          results.failed++;
          results.errors.push({
            index: i,
            lokasi,
            error: error.message,
            action: 'failed'
          });
        }
      }
    }

    // Simpan semua perubahan
    if (writeAyat(ayat)) {
      res.json({
        message: 'Repair all selesai',
        total: results.total,
        success: results.success,
        failed: results.failed,
        removed: results.removed,
        totalAfter: ayat.length,
        errors: results.errors
      });
    } else {
      res.status(500).json({ error: 'Gagal menyimpan perubahan' });
    }

  } catch (error) {
    console.error('Error in repair all:', error);
    res.status(500).json({ 
      error: 'Error saat repair all ayat',
      details: error.message 
    });
  }
});

// Server startup
app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin?pass=123456`);
});

