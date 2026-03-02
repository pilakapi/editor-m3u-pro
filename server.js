require('dotenv').config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const { Pool } = require('pg');

const app = express();

// ==========================================
// CONFIGURACIÓN DE NEON DATABASE
// ==========================================
let pool = null;

function initDatabase() {
    const connectionString = process.env.DATABASE_URL;

    if (connectionString) {
        pool = new Pool({
            connectionString: connectionString,
            ssl: {
                rejectUnauthorized: false
            }
        });

        // Crear tabla de canales si no existe
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS channels (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                logo VARCHAR(500),
                group_name VARCHAR(255),
                url TEXT NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                latency INTEGER,
                error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const createListsTableSQL = `
            CREATE TABLE IF NOT EXISTS m3u_lists (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        pool.query(createTableSQL)
            .then(() => console.log('Tabla channels creada/verificada'))
            .catch(err => console.error('Error creando tabla channels:', err));

        pool.query(createListsTableSQL)
            .then(() => console.log('Tabla m3u_lists creada/verificada'))
            .catch(err => console.error('Error creando tabla m3u_lists:', err));

        console.log('Conectado a Neon Database');
    } else {
        console.log('⚠️ DATABASE_URL no configurada - modo sin base de datos');
    }
}

// ==========================================
// AUTENTICACIÓN PIN
// ==========================================
const PIN = process.env.APP_PIN || '198823';

// Middleware para verificar autenticación
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const token = authHeader.substring(7);

    if (token !== PIN) {
        return res.status(401).json({ error: 'PIN inválido' });
    }

    next();
}

// ==========================================
// CONFIGURACIÓN EXPRESS
// ==========================================
app.use(cors());
app.use(express.json());

// Servir archivos estáticos desde la raíz del proyecto
app.use(express.static(path.join(__dirname)));

// Ruta principal - servir index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Inicializar base de datos al iniciar
initDatabase();

// ==========================================
// API: LOGIN CON PIN
// ==========================================
app.post("/api/login", (req, res) => {
    const { pin } = req.body;

    if (!pin) {
        return res.status(400).json({ error: 'Se requiere el PIN' });
    }

    if (pin === PIN) {
        // Generar un token simple (en producción usar JWT)
        const token = Buffer.from(`${PIN}:${Date.now()}`).toString('base64');
        res.json({
            success: true,
            token: token,
            message: 'Login exitoso'
        });
    } else {
        res.status(401).json({ error: 'PIN incorrecto' });
    }
});

// ==========================================
// API: VERIFICAR AUTH
// ==========================================
app.get("/api/auth-check", requireAuth, (req, res) => {
    res.json({ authenticated: true });
});

// ==========================================
// API: GUARDAR LISTA EN NEON
// ==========================================
app.post("/api/save-list", requireAuth, async (req, res) => {
    const { name, content } = req.body;

    if (!content) {
        return res.status(400).json({ error: 'Se requiere el contenido de la lista' });
    }

    if (!pool) {
        return res.status(503).json({ error: 'Base de datos no configurada' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO m3u_lists (name, content) VALUES ($1, $2) RETURNING id',
            [name || 'Lista sin nombre', content]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        console.error('Error guardando lista:', error);
        res.status(500).json({ error: 'Error al guardar la lista' });
    }
});

// ==========================================
// API: CARGAR LISTAS DESDE NEON
// ==========================================
app.get("/api/lists", requireAuth, async (req, res) => {
    if (!pool) {
        return res.status(503).json({ error: 'Base de datos no configurada' });
    }

    try {
        const result = await pool.query('SELECT id, name, created_at FROM m3u_lists ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error cargando listas:', error);
        res.status(500).json({ error: 'Error al cargar las listas' });
    }
});

// ==========================================
// API: CARGAR UNA LISTA DESDE NEON
// ==========================================
app.get("/api/list/:id", requireAuth, async (req, res) => {
    const { id } = req.params;

    if (!pool) {
        return res.status(503).json({ error: 'Base de datos no configurada' });
    }

    try {
        const result = await pool.query('SELECT * FROM m3u_lists WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lista no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error cargando lista:', error);
        res.status(500).json({ error: 'Error al cargar la lista' });
    }
});

// ==========================================
// API: GUARDAR CANALES EN NEON
// ==========================================
app.post("/api/save-channels", requireAuth, async (req, res) => {
    const { channels } = req.body;

    if (!channels || !Array.isArray(channels)) {
        return res.status(400).json({ error: 'Se requiere un array de canales' });
    }

    if (!pool) {
        return res.status(503).json({ error: 'Base de datos no configurada' });
    }

    try {
        // Limpiar canales anteriores
        await pool.query('DELETE FROM channels');

        // Insertar nuevos canales
        for (const channel of channels) {
            await pool.query(
                'INSERT INTO channels (name, logo, group_name, url, status, latency, error) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [channel.name, channel.logo, channel.group, channel.url, channel.status, channel.latency, channel.error]
            );
        }

        res.json({ success: true, count: channels.length });
    } catch (error) {
        console.error('Error guardando canales:', error);
        res.status(500).json({ error: 'Error al guardar los canales' });
    }
});

// ==========================================
// API: CARGAR CANALES DESDE NEON
// ==========================================
app.get("/api/channels", requireAuth, async (req, res) => {
    if (!pool) {
        return res.status(503).json({ error: 'Base de datos no configurada' });
    }

    try {
        const result = await pool.query('SELECT * FROM channels ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        console.error('Error cargando canales:', error);
        res.status(500).json({ error: 'Error al cargar los canales' });
    }
});

// ==========================================
// FUNCIÓN PARA VERIFICAR STREAM DE VIDEO
// ==========================================
async function checkStream(url) {
    const startTime = Date.now();

    try {
        // Intentar primero con método HEAD (más rápido)
        const response = await axios.head(url, {
            timeout: 5000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "*/*"
            },
            validateStatus: function(status) {
                return status < 500; // Aceptar cualquier código menor a 500
            }
        });

        const latency = Date.now() - startTime;

        // Verificar si el código de estado es exitoso
        if (response.status >= 200 && response.status < 400) {
            return {
                status: "online",
                code: response.status,
                latency: latency,
                method: "HEAD"
            };
        }

        return {
            status: "offline",
            code: response.status,
            error: `Código HTTP: ${response.status}`,
            latency: latency,
            method: "HEAD"
        };

    } catch (error) {
        // Si HEAD falla, intentar con GET parcial (solo primeros bytes)
        try {
            const response = await axios.get(url, {
                timeout: 5000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "*/*",
                    "Range": "bytes=0-128" // Solo pedir los primeros bytes
                },
                maxContentLength: 200,
                validateStatus: function(status) {
                    return status < 500;
                }
            });

            const latency = Date.now() - startTime;

            if (response.status >= 200 && response.status < 400) {
                return {
                    status: "online",
                    code: response.status,
                    latency: latency,
                    method: "GET"
                };
            }

            return {
                status: "offline",
                code: response.status,
                error: `Código HTTP: ${response.status}`,
                latency: latency,
                method: "GET"
            };

        } catch (getError) {
            const latency = Date.now() - startTime;

            // Determinar tipo de error
            let errorMessage = getError.code || getError.message;

            if (getError.code === 'ECONNABORTED') {
                errorMessage = "Tiempo de espera agotado";
            } else if (getError.code === 'ENOTFOUND') {
                errorMessage = "Dominio no encontrado";
            } else if (getError.code === 'ECONNREFUSED') {
                errorMessage = "Conexión rechazada";
            } else if (getError.response) {
                errorMessage = `Código HTTP: ${getError.response.status}`;
            }

            return {
                status: "offline",
                error: errorMessage,
                latency: latency,
                method: "ERROR"
            };
        }
    }
}

// ==========================================
// API: ESCANEAR CANALES (Endpoint principal)
// ==========================================
app.post("/scan", requireAuth, async (req, res) => {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({
            error: "Se requiere un array de URLs"
        });
    }

    // Procesar en paralelo con límite de concurrencia
    const batchSize = 10;
    const results = [];

    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (url) => {
                const result = await checkStream(url);
                return { url, ...result };
            })
        );
        results.push(...batchResults);
    }

    res.json(results);
});

// ==========================================
// API: ESCANEAR UN SOLO CANAL
// ==========================================
app.post("/scan-single", requireAuth, async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: "Se requiere una URL"
        });
    }

    const result = await checkStream(url);
    res.json({ url, ...result });
});

// ==========================================
// API: CARGAR LISTA DESDE URL
// ==========================================
app.post("/load", requireAuth, async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: "Se requiere una URL"
        });
    }

    try {
        const response = await axios.get(url, {
            timeout: 30000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "*/*"
            },
            maxContentLength: 10 * 1024 * 1024 // 10MB max
        });

        res.send(response.data);
    } catch (error) {
        res.status(500).json({
            error: "No se pudo cargar la lista: " + (error.message || "Error desconocido")
        });
    }
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
app.listen(PORT, () => {
    console.log("========================================");
    console.log("  M3U Editor Pro - Servidor iniciado");
    console.log("  Puerto: " + PORT);
    console.log("  PIN de acceso: " + PIN);
    console.log("  Base de datos: " + (pool ? 'Neon conectada' : 'No configurada'));
    console.log("========================================");
});
