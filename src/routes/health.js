/**
 * Health & Status Routes
 * Server health, stats, and debugging endpoints
 */
const express = require('express');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const config = require('../config/env');
const { TOKENS, PROGRAMS } = require('../config/constants');
const { pump, logger } = require('../services');

const router = express.Router();

// Admin auth middleware for sensitive endpoints
const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_API_KEY;

    // If no admin key configured, block access in production
    if (!expectedKey && process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Debug endpoint disabled in production' });
    }

    // If admin key configured, require it
    if (expectedKey && apiKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
};

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection, devKeypair, db, redis, getStats, getTotalLaunches, globalState } = deps;

    // Version endpoint
    router.get('/version', (req, res) => {
        res.json({ version: config.VERSION });
    });

    // Health check
    router.get('/health', async (req, res) => {
        try {
            const cachedHealth = await redis.smartCache('health_data', 10, async () => {
                const stats = await getStats();
                const launches = await getTotalLaunches();
                const logs = await db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50');

                const volRes = await db.get('SELECT SUM(volume24h) as total FROM tokens');
                const totalVolume = volRes?.total || 0;

                const currentBalance = await connection.getBalance(devKeypair.publicKey);

                const { bcVault, ammVaultAta } = pump.getCreatorFeeVaults(devKeypair.publicKey);
                let totalPendingFees = 0;

                try {
                    const bcInfo = await connection.getAccountInfo(bcVault);
                    if (bcInfo) totalPendingFees += bcInfo.lamports;
                } catch (e) {
                    logger.debug('Failed to fetch bonding curve info', { error: e.message });
                }

                try {
                    const ammVaultAtaKey = await ammVaultAta;
                    const wsolBal = await connection.getTokenAccountBalance(ammVaultAtaKey);
                    if (wsolBal.value.amount) totalPendingFees += Number(wsolBal.value.amount);
                } catch (e) {
                    logger.debug('Failed to fetch AMM vault balance', { error: e.message });
                }

                let pumpHoldings = 0;
                try {
                    const devPumpAta = await getAssociatedTokenAddress(
                        TOKENS.PUMP, devKeypair.publicKey, false, PROGRAMS.TOKEN_2022
                    );
                    const tokenBal = await connection.getTokenAccountBalance(devPumpAta);
                    if (tokenBal.value.uiAmount) pumpHoldings = tokenBal.value.uiAmount;
                } catch (e) {
                    logger.debug('Failed to fetch PUMP holdings', { error: e.message });
                }

                return { stats, launches, logs, currentBalance, pumpHoldings, totalPendingFees, totalVolume };
            });

            const totalFeesLamports = (cachedHealth.stats.lifetimeFeesLamports || 0) +
                                     (cachedHealth.stats.lifetimeCreatorFeesLamports || 0);

            res.json({
                status: "online",
                wallet: devKeypair.publicKey.toString(),
                lifetimeFees: (totalFeesLamports / LAMPORTS_PER_SOL).toFixed(4),
                totalPumpBought: (cachedHealth.stats.totalPumpBoughtLamports / LAMPORTS_PER_SOL).toFixed(4),
                totalPumpTokensBought: (cachedHealth.stats.totalPumpTokensBought || 0).toLocaleString('en-US', {maximumFractionDigits: 0}),
                pumpHoldings: cachedHealth.pumpHoldings,
                totalPoints: globalState.totalPoints,
                totalLaunches: cachedHealth.launches,
                recentLogs: cachedHealth.logs.map(l => ({ ...JSON.parse(l.data), type: l.type, timestamp: l.timestamp })),
                headerImageUrl: config.HEADER_IMAGE_URL,
                currentFeeBalance: (cachedHealth.totalPendingFees / LAMPORTS_PER_SOL).toFixed(4),
                lastClaimTime: cachedHealth.stats.lastClaimTimestamp || 0,
                lastClaimAmount: (cachedHealth.stats.lastClaimAmountLamports / LAMPORTS_PER_SOL).toFixed(4),
                nextCheckTime: cachedHealth.stats.nextCheckTimestamp || (Date.now() + 5*60*1000),
                totalVolume: cachedHealth.totalVolume
            });
        } catch (e) {
            res.status(500).json({ error: "DB Error" });
        }
    });

    // Debug logs (protected endpoint)
    router.get('/debug/logs', adminAuth, (req, res) => {
        const fs = require('fs');
        const path = require('path');

        // Validate and sanitize path
        const logPath = path.resolve(config.DISK_ROOT, 'server_debug.log');
        const expectedBase = path.resolve(config.DISK_ROOT);

        if (!logPath.startsWith(expectedBase)) {
            logger.warn('Path traversal attempt detected');
            return res.status(403).json({ error: 'Invalid path' });
        }

        if (fs.existsSync(logPath)) {
            const stats = fs.statSync(logPath);
            const stream = fs.createReadStream(logPath, { start: Math.max(0, stats.size - 50000) });
            stream.on('error', (err) => {
                logger.error('Error reading log file', { error: err.message });
                res.status(500).send('Error reading log file');
            });
            stream.pipe(res);
        } else {
            res.send("No logs yet.");
        }
    });

    return router;
}

module.exports = { init };
