require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PINATA_JWT = process.env.PINATA_JWT;

if (!DEV_WALLET_PRIVATE_KEY || !HELIUS_API_KEY || !PINATA_JWT) {
    console.error("❌ ERROR: Missing Environment Variables.");
    process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const CONNECTION_CONFIG = { commitment: "confirmed", confirmTransactionInitialTimeout: 120000 };

// Program IDs
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAM_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

const FEE_RECIPIENT = new PublicKey("FNLWHjvjptwC7LxycdK3Knqcv5ptC19C9rynn6u2S1tB");

// --- Setup ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const connection = new Connection(RPC_URL, CONNECTION_CONFIG);
let devKeypair;
try {
    devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_PRIVATE_KEY));
} catch (err) {
    console.error("❌ Invalid Private Key format. Check .env");
    process.exit(1);
}
const wallet = new Wallet(devKeypair);
const provider = new AnchorProvider(connection, wallet, CONNECTION_CONFIG);

// --- CRITICAL FIX START ---
const idlRaw = fs.readFileSync('./pump_idl.json', 'utf8');
const idl = JSON.parse(idlRaw);

// Explicitly forcing the address in the IDL object itself to match the PublicKey
idl.address = PUMP_PROGRAM_ID.toString();

// Initialize Program
// Passing PUMP_PROGRAM_ID as the second argument forces Anchor to use this address
// instead of looking it up in the IDL or defaulting.
const program = new Program(idl, PUMP_PROGRAM_ID, provider);
// --- CRITICAL FIX END ---

// --- Helper Functions ---

async function uploadImageToPinata(base64Data) {
    try {
        const base64Content = base64Data.split(',')[1];
        const buffer = Buffer.from(base64Content, 'base64');
        const formData = new FormData();
        formData.append('file', buffer, { filename: 'token_image.png' });

        const response = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
            headers: {
                'Authorization': `Bearer ${PINATA_JWT}`,
                ...formData.getHeaders()
            }
        });
        return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
    } catch (error) {
        console.error("❌ Image Upload Failed:", error.message);
        return "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8"; 
    }
}

async function uploadMetadataToPinata(name, symbol, description, twitter, website, imageBase64) {
    let imageUrl = "https://gateway.pinata.cloud/ipfs/QmPc5gX8W8h9j5h8x8h8h8h8h8h8h8h8h8h8h8h8h8"; 
    
    if (imageBase64) {
        console.log("Uploading Image to Pinata...");
        imageUrl = await uploadImageToPinata(imageBase64);
    }

    const metadata = {
        name: name,
        symbol: symbol,
        description: description,
        image: imageUrl,
        extensions: { twitter: twitter || "", website: website || "" }
    };

    try {
        const response = await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', metadata, {
            headers: { 'Authorization': `Bearer ${PINATA_JWT}` }
        });
        return `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`;
    } catch (error) {
        console.error("Metadata Upload Error:", error.message);
        throw new Error("Failed to upload metadata");
    }
}

function getPumpPDAs(mint, creator) {
    const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
    const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID);
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
    const [globalVolume] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM_ID);
    const [userVolume] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), creator.toBuffer()], PUMP_PROGRAM_ID);
    const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], FEE_PROGRAM_ID);
    const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);

    return { mintAuthority, bondingCurve, global, eventAuthority, globalVolume, userVolume, feeConfig, creatorVault };
}

function getMayhemPDAs(mint) {
    const [globalParams] = PublicKey.findProgramAddressSync([Buffer.from("global-params")], MAYHEM_PROGRAM_ID);
    const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("sol-vault")], MAYHEM_PROGRAM_ID);
    const [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mint.toBuffer()], MAYHEM_PROGRAM_ID);
    return { globalParams, solVault, mayhemState };
}

function getATA(mint, owner) {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM_2022_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
}

// --- Routes ---

app.get('/api/health', (req, res) => {
    res.json({ status: "online", wallet: devKeypair.publicKey.toString() });
});

app.post('/api/deploy', async (req, res) => {
    try {
        const { name, ticker, description, twitter, website, userTx, userPubkey, image } = req.body;
        console.log(`🔥 Request: Deploy ${ticker}`);

        const txInfo = await connection.getParsedTransaction(userTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!txInfo) return res.status(400).json({ error: "Transaction not found." });
        
        const transfers = txInfo.transaction.message.instructions.flatMap(ix => {
            if (ix.programId.toString() === SystemProgram.programId.toString() && ix.parsed.type === 'transfer') {
                return [ix.parsed.info];
            }
            return [];
        });

        const validPayment = transfers.some(t => t.destination === devKeypair.publicKey.toString() && t.lamports >= 0.05 * LAMPORTS_PER_SOL);
        if (!validPayment) return res.status(400).json({ error: "0.05 SOL Payment verification failed." });

        const metadataUri = await uploadMetadataToPinata(name, ticker, description, twitter, website, image);
        console.log("✅ Metadata:", metadataUri);

        const mintKeypair = Keypair.generate();
        const mint = mintKeypair.publicKey;
        const creator = devKeypair.publicKey;
        
        const { mintAuthority, bondingCurve, global, eventAuthority, globalVolume, userVolume, feeConfig, creatorVault } = getPumpPDAs(mint, creator);
        const { globalParams, solVault, mayhemState } = getMayhemPDAs(mint);
        const associatedBondingCurve = getATA(mint, bondingCurve);
        const mayhemTokenVault = getATA(mint, solVault);
        const associatedUser = getATA(mint, creator);

        const createIx = await program.methods.createV2(name, ticker, metadataUri, creator, false)
            .accounts({
                mint, mintAuthority, bondingCurve, associatedBondingCurve,
                global, user: creator,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_2022_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                mayhemProgramId: MAYHEM_PROGRAM_ID,
                globalParams, solVault, mayhemState, mayhemTokenVault,
                eventAuthority, program: PUMP_PROGRAM_ID
            })
            .instruction();

        const buyIx = await program.methods.buyExactSolIn(new BN(0.01 * LAMPORTS_PER_SOL), new BN(1), false)
            .accounts({
                global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve,
                associatedUser, user: creator,
                systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID,
                creatorVault, eventAuthority, program: PUMP_PROGRAM_ID,
                globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume,
                feeConfig, feeProgram: FEE_PROGRAM_ID
            })
            .instruction();

        const tx = new Transaction().add(createIx).add(buyIx);
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = creator;
        
        const sig = await sendAndConfirmTransaction(connection, tx, [devKeypair, mintKeypair]);
        console.log(`✅ Deployed: ${sig}`);

        setTimeout(async () => {
            try {
                const bal = await connection.getTokenAccountBalance(associatedUser);
                if (bal.value.uiAmount > 0) {
                    const sellIx = await program.methods.sell(new BN(bal.value.amount), new BN(0))
                        .accounts({
                            global, feeRecipient: FEE_RECIPIENT, mint, bondingCurve, associatedBondingCurve,
                            associatedUser, user: creator,
                            systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_2022_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            creatorVault, eventAuthority, program: PUMP_PROGRAM_ID,
                            globalVolumeAccumulator: globalVolume, userVolumeAccumulator: userVolume,
                            feeConfig, feeProgram: FEE_PROGRAM_ID
                        })
                        .instruction();
                    const sellTx = new Transaction().add(sellIx);
                    const sellSig = await sendAndConfirmTransaction(connection, sellTx, [devKeypair]);
                    console.log(`💰 Sold: ${sellSig}`);
                }
            } catch (e) { console.error("Sell error:", e.message); }
        }, 1500); 

        res.json({ success: true, mint: mint.toString(), signature: sig });

    } catch (err) {
        console.error("🔥 Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🔥 Pump Launcher Backend running on port ${PORT}`));
