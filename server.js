import express from 'express';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.json());

// Serve static project files
app.use('/src', express.static(join(__dirname, 'src')));
app.use('/tests', express.static(join(__dirname, 'tests')));
app.use('/docs', express.static(join(__dirname, 'docs')));

app.get('/style.css', (req, res) => {
    res.sendFile(join(__dirname, 'style.css'));
});

app.get('/settings.html', (req, res) => {
    res.sendFile(join(__dirname, 'settings.html'));
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(join(__dirname, 'manifest.json'));
});

app.get('/index.js', (req, res) => {
    res.sendFile(join(__dirname, 'index.js'));
});

// API endpoint to run the test suite
app.get('/api/tests/run', (req, res) => {
    exec('node --test tests/*.test.mjs', { cwd: __dirname }, (error, stdout, stderr) => {
        res.json({
            success: !error,
            code: error ? error.code : 0,
            stdout,
            stderr,
        });
    });
});

// API endpoint to get documentation and markdown specs
app.get('/api/docs/:doc', async (req, res) => {
    const docName = req.params.doc;
    const allowedDocs = {
        'readme': 'README.md',
        'architecture': 'docs/architecture.md',
        'roadmap': 'roadmap.md',
        'manifest': 'manifest.json',
    };

    const targetFile = allowedDocs[docName];
    if (!targetFile) {
        return res.status(404).json({ error: 'Documentation file not found' });
    }

    try {
        const content = await readFile(join(__dirname, targetFile), 'utf-8');
        res.json({ name: targetFile, content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve workbench HTML
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
    console.log(`[Chromatic Images] Workbench running on http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => {
    server.close(() => {
        process.exit(0);
    });
});
