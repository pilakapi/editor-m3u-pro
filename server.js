const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

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
app.post("/scan", async (req, res) => {
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
app.post("/scan-single", async (req, res) => {
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
app.post("/load", async (req, res) => {
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
    console.log("========================================");
});

