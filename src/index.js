/**
 * ASDev
 * Main Entry Point
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// Internal imports
const config = require('./config/env');
const { logger, database, redis, twitter, solana } = require('./services');
const routes = require('./routes');
const tasks = require('./tasks');

// Global state (shared across modules)
const globalState = {
    lastBackendUpdate: Date.now(),
    asdfTop50Holders: new Set(),
    totalPoints: 0,
    devPumpHoldings: 0,
    userExpectedAirdrops: new Map(),
    userPointsMap: new Map(),
};

/**
 * Main initialization function
 */
async function main() {
    logger.info(`Starting ASDev ${config.VERSION}...`);

    // Initialize database
    await database.initDB();
    const db = database.getDB();

    // Initialize Redis
    redis.init();

    // Initialize Twitter
    twitter.init();

    // Initialize Solana connection
    const connection = new Connection(config.RPC_URL, "confirmed");
    const devKeypair = Keypair.fromSecretKey(bs58.decode(config.DEV_WALLET_PRIVATE_KEY));
    const wallet = new Wallet(devKeypair);

    logger.info(`Network: ${config.SOLANA_NETWORK.toUpperCase()} | RPC: ${config.RPC_URL.includes('devnet') ? 'Devnet' : (config.HELIUS_API_KEY ? 'Helius' : 'Public Mainnet')}`);
    logger.info(`Wallet: ${devKeypair.publicKey.toString()}`);

    // Create Express app
    const app = express();

    // Security middleware
    app.use(helmet({
        contentSecurityPolicy: false, // Disable CSP for frontend flexibility
        crossOriginEmbedderPolicy: false
    }));
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));

    // Rate limiting
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // 100 requests per window
        message: { error: 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false
    });

    const deployLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 3, // 3 deployments per minute
        message: { error: 'Too many deployment requests, please wait' },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.use('/api/', apiLimiter);
    app.use('/api/deploy', deployLimiter);

    // Serve frontend
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'asdev_frontend.html'));
    });

    // Database helper functions
    const addFees = async (amount) => {
        if (!db) return;
        await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amount, 'accumulatedFeesLamports']);
        await db.run('UPDATE stats SET value = value + ? WHERE key = ?', [amount, 'lifetimeFeesLamports']);
    };

    const getStats = async () => {
        if (!db) return {};
        const rows = await db.all('SELECT key, value FROM stats');
        return rows.reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {});
    };

    const getTotalLaunches = async () => {
        if (!db) return 0;
        const res = await db.get('SELECT COUNT(*) as count FROM tokens');
        return res ? res.count : 0;
    };

    const recordClaim = async (amount) => {
        if (!db) return;
        await db.run('UPDATE stats SET value = ? WHERE key = ?', [Date.now(), 'lastClaimTimestamp']);
        await db.run('UPDATE stats SET value = ? WHERE key = ?', [amount, 'lastClaimAmountLamports']);
    };

    const updateNextCheckTime = async () => {
        if (!db) return;
        const nextCheck = Date.now() + (5 * 60 * 1000);
        await db.run('UPDATE stats SET value = ? WHERE key = ?', [nextCheck, 'nextCheckTimestamp']);
    };

    const logPurchase = async (type, data) => {
        if (!db) return;
        try {
            await db.run(
                'INSERT INTO logs (type, data, timestamp) VALUES (?, ?, ?)',
                [type, JSON.stringify(data), new Date().toISOString()]
            );
        } catch (e) {
            logger.error("Log error", { error: e.message });
        }
    };

    const saveTokenData = async (pubkey, mint, metadata) => {
        if (!db) return;
        try {
            await db.run(`
                INSERT INTO tokens (mint, userPubkey, name, ticker, description, twitter, website, image, isMayhemMode, metadataUri)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [mint, pubkey, metadata.name, metadata.ticker, metadata.description,
                metadata.twitter, metadata.website, metadata.image, metadata.isMayhemMode, metadata.metadataUri]);

            // Save to file system
            const shard = pubkey.slice(0, 2).toLowerCase();
            const dir = path.join(database.DATA_DIR, shard);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, `${mint}.json`),
                JSON.stringify({ userPubkey: pubkey, mint, metadata, timestamp: new Date().toISOString() }, null, 2)
            );
        } catch (e) {
            logger.error("Save Token Error", { error: e.message });
        }
    };

    const refundUser = async (userPubkeyStr, reason) => {
        try {
            const { PublicKey } = require('@solana/web3.js');
            const userPubkey = new PublicKey(userPubkeyStr);
            const tx = new Transaction();
            solana.addPriorityFee(tx);
            tx.add(SystemProgram.transfer({
                fromPubkey: devKeypair.publicKey,
                toPubkey: userPubkey,
                lamports: (config.DEPLOYMENT_FEE_SOL - 0.001) * LAMPORTS_PER_SOL
            }));
            const sig = await solana.sendTxWithRetry(tx, [devKeypair]);
            logger.info(`REFUNDED ${userPubkeyStr}: ${sig} (Reason: ${reason})`);
            return sig;
        } catch (e) {
            logger.error(`REFUND FAILED: ${e.message}`);
            return null;
        }
    };

    // Dependencies object for modules
    const deps = {
        connection,
        devKeypair,
        wallet,
        db,
        redis,
        globalState,
        addFees,
        getStats,
        getTotalLaunches,
        recordClaim,
        updateNextCheckTime,
        logPurchase,
        saveTokenData,
        refundUser,
    };

    // Register routes
    routes.register(app, deps);

    // Start background tasks
    tasks.startAll(deps);

    // Start server
    app.listen(config.PORT, () => {
        logger.info(`Server ${config.VERSION} running on port ${config.PORT}`);
    });
}

// Graceful shutdown
const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully...`);
    try {
        const db = database.getDB();
        if (db) await db.close();
        redis.getConnection()?.disconnect();
        logger.info('Cleanup complete, exiting');
    } catch (e) {
        logger.error('Shutdown error', { error: e.message });
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Run main
main().catch(err => {
    logger.error("Fatal error", { error: err.message, stack: err.stack });
    process.exit(1);
});
