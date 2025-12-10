/**
 * Solana Routes
 * Balance and blockhash endpoints
 */
const express = require('express');
const { PublicKey } = require('@solana/web3.js');

const router = express.Router();

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection } = deps;

    // Get balance
    router.get('/balance', async (req, res) => {
        try {
            const { pubkey } = req.query;
            if (!pubkey) {
                return res.status(400).json({ error: "Missing pubkey" });
            }
            const balance = await connection.getBalance(new PublicKey(pubkey));
            res.json({ balance });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get blockhash
    router.get('/blockhash', async (req, res) => {
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
            res.json({ blockhash, lastValidBlockHeight });
        } catch (err) {
            res.status(500).json({ error: "Failed to get blockhash" });
        }
    });

    return router;
}

module.exports = { init };
