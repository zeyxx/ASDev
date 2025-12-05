require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { 
    Connection, 
    Keypair, 
    PublicKey, 
    SystemProgram, 
    LAMPORTS_PER_SOL, 
    Transaction, 
    sendAndConfirmTransaction,
    TransactionInstruction 
} = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet } = require('@coral-xyz/anchor');
const anchor = require('@coral-xyz/anchor');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const axios = require('axios');
const FormData = require('form-data');
const { Readable } = require('stream');
// --- CORRECTED BORSH IMPORT ---
const { Buffer } = require('buffer'); 
// No need to explicitly import borsh package here as Anchor provides its utilities,
// but we rely on the @coral-xyz/borsh package being installed.


// --- CONFIGURATION & PROGRAM IDS ---
const PORT = process.env.PORT || 3000;
const DEV_WALLET_ADDRESS = "FNLWHjvjptwC7LxycdK3Knqcv5ptC19C9rynn6u2S1tB"; // User specified Dev Pubkey
const FEE_AMOUNT_SOL = 0.05;
const STATIC_BUY_AMOUNT_SOL = 0.01; 

// Program IDs (Confirmed from documentation)
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Required PDAs
const GLOBAL_PARAMS_PUBKEY = new PublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ");
const SOL_VAULT_PUBKEY = new PublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s");
const GLOBAL_PDA = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"); 

// RPC Endpoint: Using Helius if API key is set
const RPC_ENDPOINT = process.env.HELIUS_API_KEY 
    ? `https://api.helius.xyz/v1/jsonrpc?api-key=${process.env.HELIUS_API_KEY}` 
    : "https://api.mainnet-beta.solana.com";


// In-memory store for processed signatures to prevent replay
const processedSignatures = new Set();

const app = express();
app.use(cors());
app.use(express.json()); 

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 1 }
});

// --- Dev Wallet & Solana Setup ---
let walletKeyPair;

const privateKeyBase58 = process.env.PRIVATE_KEY;

if (!privateKeyBase58) {
    console.error("--- FATAL ERROR: PRIVATE_KEY MISSING ---");
    console.error("The environment variable 'PRIVATE_KEY' is not set.");
    process.exit(1); 
}

try {
    walletKeyPair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    console.log(`[Startup] Wallet Key loaded successfully.`);
} catch (e) {
    console.error("--- FATAL ERROR: INVALID PRIVATE KEY FORMAT ---");
    console.error("The key found in PRIVATE_KEY failed to decode. Reason:", e.message);
    process.exit(1); 
}

const wallet = new Wallet(walletKeyPair);
const connection = new Connection(RPC_ENDPOINT, "confirmed");
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
const creatorPubkey = wallet.publicKey;

// --- ANCHOR IDL (FINAL CLEANUP) ---
const PUMP_IDL = {
  "version": "0.1.0",
  "name": "pump",
  "instructions": [
    {
      "name": "createV2",
      "accounts": [
        { "name": "mint", "isMut": true, "isSigner": true },
        { "name": "mintAuthority", "isMut": false, "isSigner": false },
        { "name": "bondingCurve", "isMut": true, "isSigner": false },
        { "name": "associatedBondingCurve", "isMut": true, "isSigner": false },
        { "name": "global", "isMut": false, "isSigner": false },
        { "name": "user", "isMut": true, "isSigner": true },
        { "name": "systemProgram", "isMut": false, "isSigner": false },
        { "name": "tokenProgram", "isMut": false, "isSigner": false }, 
        { "name": "associatedTokenProgram", "isMut": false, "isSigner": false },
        { "name": "mayhemProgramId", "isMut": true, "isSigner": false },
        { "name": "globalParams", "isMut": false, "isSigner": false },
        { "name": "solVault", "isMut": true, "isSigner": false },
        { "name": "mayhemState", "isMut": true, "isSigner": false },
        { "name": "mayhemTokenVault", "isMut": true, "isSigner": false },
        { "name": "eventAuthority", "isMut": false, "isSigner": false },
        { "name": "program", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "name", "type": "string" },
        { "name": "symbol", "type": "string" },
        { "name": "uri", "type": "string" },
        { "name": "creator", "type": "pubkey" }, 
        { "name": "isMayhemMode", "type": "bool" }
      ]
    },
    {
      "name": "buyExactSolIn", 
      "accounts": [
        { "name": "global", "isMut": false, "isSigner": false },
        { "name": "feeRecipient", "isMut": true, "isSigner": false },
        { "name": "mint", "isMut": false, "isSigner": false },
        { "name": "bondingCurve", "isMut": true, "isSigner": false },
        { "name": "associatedBondingCurve", "isMut": true, "isSigner": false },
        { "name": "associatedUser", "isMut": true, "isSigner": false },
        { "name": "user", "isMut": true, "isSigner": true },
        { "name": "systemProgram", "isMut": false, "isSigner": false },
        { "name": "tokenProgram", "isMut": false, "isSigner": false },
        { "name": "creatorVault", "isMut": true, "isSigner": false },
        { "name": "eventAuthority", "isMut": false, "isSigner": false },
        { "name": "program", "isMut": false, "isSigner": false },
        { "name": "globalVolumeAccumulator", "isMut": false, "isSigner": false },
        { "name": "userVolumeAccumulator", "isMut": true, "isSigner": false },
        { "name": "feeConfig", "isMut": false, "isSigner": false },
        { "name": "feeProgram", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "spendableSolIn", "type": "u64" },
        { "name": "minTokensOut", "type": "u64" },
        { "name": "trackVolume", "type": { "option": "bool" } } 
      ]
    },
    {
        "name": "sellTokens", 
        "accounts": [
            { "name": "global", "isMut": false, "isSigner": false },
            { "name": "feeRecipient", "isMut": true, "isSigner": false },
            { "name": "mint", "isMut": false, "isSigner": false },
            { "name": "bondingCurve", "isMut": true, "isSigner": false },
            { "name": "associatedBondingCurve", "isMut": true, "isSigner": false },
            { "name": "associatedUser", "isMut": true, "isSigner": false },
            { "name": "user", "isMut": true, "isSigner": true },
            { "name": "systemProgram", "isMut": false, "isSigner": false },
            { "name": "tokenProgram", "isMut": false, "isSigner": false },
            { "name": "creatorVault", "isMut": true, "isSigner": false },
            { "name": "eventAuthority", "isMut": false, "isSigner": false },
            { "name": "program", "isMut": false, "isSigner": false },
            { "name": "globalVolumeAccumulator", "isMut": false, "isSigner": false },
            { "name": "userVolumeAccumulator", "isMut": true, "isSigner": false },
            { "name": "feeConfig", "isMut": false, "isSigner": false },
            { "name": "feeProgram", "isMut": false, "isSigner": false }
        ],
        "args": [
            { "name": "amountTokensIn", "type": "u64" },
            { "name": "minSolOut", "type": "u64" },
            { "name": "trackVolume", "type": { "option": "bool" } } 
        ]
    },
    {
        "name": "collectCreatorFee",
        "accounts": [
            { "name": "creator", "isMut": true, "isSigner": false },
            { "name": "creatorVault", "isMut": true, "isSigner": false },
            { "name": "systemProgram", "isMut": false, "isSigner": false },
            { "name": "eventAuthority", "isMut": false, "isSigner": false },
            { "name": "program", "isMut": false, "isSigner": false }
        ],
        "args": []
    }
  ]
  // Removed types block entirely
};

const program = new Program(PUMP_IDL, PUMP_PROGRAM_ID, provider);

// --- MANUAL INSTRUCTION ENCODING SCHEMAS ---

// 8 bytes discriminator + argument data
const BUY_IX_DISCRIMINATOR = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]); // Hash of 'buyExactSolIn'
const SELL_IX_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]); // Hash of 'sellTokens'


// Encodes the BUY instruction data (Discriminator + Args)
function encodeBuyInstructionData(spendableSolIn, minTokensOut, trackVolume) {
    // 8 bytes discriminator + 8 bytes u64 + 8 bytes u64 + 2 bytes Option<bool>
    const buffer = new anchor.utils.Buffer(26); 
    let offset = 0;

    // 1. Write Discriminator
    BUY_IX_DISCRIMINATOR.copy(buffer, offset);
    offset += 8;

    // 2. Write Args (u64 lamports, u64 min tokens)
    buffer.writeBigUInt64LE(BigInt(spendableSolIn), offset);
    offset += 8;
    buffer.writeBigUInt64LE(BigInt(minTokensOut), offset);
    offset += 8;

    // 3. Write Option<bool> (TrackVolume)
    if (trackVolume === true) {
        buffer.writeUInt8(1, offset++); // Option::Some
        buffer.writeUInt8(1, offset++); // bool value (true)
    } else {
        buffer.writeUInt8(0, offset++); // Option::None
    }

    // Return only the written buffer segment
    return buffer.slice(0, offset);
}

// Encodes the SELL instruction data (Discriminator + Args)
function encodeSellInstructionData(amountTokensIn, minSolOut, trackVolume) {
    // 8 bytes discriminator + 8 bytes u64 + 8 bytes u64 + 2 bytes Option<bool>
    const buffer = new anchor.utils.Buffer(26); 
    let offset = 0;

    // 1. Write Discriminator
    SELL_IX_DISCRIMINATOR.copy(buffer, offset);
    offset += 8;

    // 2. Write Args (u64 tokens, u64 min SOL out)
    buffer.writeBigUInt64LE(BigInt(amountTokensIn), offset);
    offset += 8;
    buffer.writeBigUInt64LE(BigInt(minSolOut), offset);
    offset += 8;

    // 3. Write Option<bool> (TrackVolume)
    if (trackVolume === true) {
        buffer.writeUInt8(1, offset++); // Option::Some
        buffer.writeUInt8(1, offset++); // bool value (true)
    } else {
        buffer.writeUInt8(0, offset++); // Option::None
    }
    
    return buffer.slice(0, offset);
}


// --- CONTENT MODERATION LAYER (Unchanged) ---
async function checkContentSafety(fileBuffer, mimeType) {
    console.log(`[Moderation] Scanning incoming file (${(fileBuffer.length / 1024).toFixed(2)} KB) using Gemini...`);
    
    const base64ImageData = fileBuffer.toString('base64');
    const apiKey = ""; 

    const systemPrompt = "You are a content safety expert. Your sole task is to check the provided image only for content that is strictly and universally illegal. This includes, but is not limited to: Child Sexual Abuse Material (CSAM), non-consensual intimate imagery, content explicitly promoting illegal acts (such as specific instructions for major violence or bomb-making), or real-world symbols of hate/terrorism. Respond ONLY with the single word 'SAFE' if the image does not contain strictly illegal content. Respond ONLY with the single word 'UNSAFE' if the image appears to depict or promote illegal content as defined above.";
    const userQuery = "Analyze this image for strictly illegal and universally prohibited content compliance.";

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: userQuery },
                    {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64ImageData
                        }
                    }
                ]
            }
        ],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        config: {
            temperature: 0.1 
        }
    };
    
    const MAX_RETRIES = 3;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const lastResult = await response.json();

            if (!response.ok) {
                if (response.status >= 500 && i < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
                    continue; 
                }
                throw new Error(`API error: ${lastResult.error?.message || response.statusText}`);
            }

            const text = lastResult.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
            
            if (!text || text.includes('UNSAFE')) {
                throw new Error("Content failed moderation check. Strictly illegal content detected based on policy review.");
            }
            
            if (text.includes('SAFE')) {
                console.log("[Moderation] Image classified as SAFE.");
                return true;
            }

            throw new Error(`Moderation API returned an ambiguous response: ${text}`);

        } catch (error) {
            if (error.message.includes("illegal content detected")) {
                 throw error; 
            }
            if (i === MAX_RETRIES - 1) {
                console.error("Gemini API call failed after max retries.");
                throw new Error("Temporary moderation service error. Please try again.");
            }
            console.warn(`Retry attempt ${i + 1} failed: ${error.message}`);
        }
    }

    throw new Error("Moderation service failed to return a valid classification.");
}


// --- IPFS HELPERS (Unchanged functionality) ---

async function uploadFileToPinata(file, name) {
    if (!process.env.PINATA_JWT) {
        throw new Error("PINATA_JWT environment variable is missing.");
    }
    
    const url = `https://api.pinata.cloud/pinning/pinFileToIPFS`;
    const data = new FormData();

    const fileStream = new Readable();
    fileStream.push(file.buffer);
    fileStream.push(null);
    data.append('file', fileStream, { filename: name || file.originalname });

    const pinataMetadata = JSON.stringify({ name: `${name} Image` });
    data.append('pinataMetadata', pinataMetadata);

    try {
        const response = await axios.post(url, data, {
            maxBodyLength: 'Infinity',
            headers: {
                'Authorization': `Bearer ${process.env.PINATA_JWT}`,
            }
        });
        const ipfsHash = response.data.IpfsHash;
        console.log("Image successfully uploaded to Pinata:", ipfsHash);
        return `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;
    } catch (error) {
        console.error("IPFS Image Upload Error:", error.response?.data || error.message);
        throw new Error("Failed to upload image to Pinata. Check Pinata JWT and file size.");
    }
}

async function uploadMetadataToIPFS(metadata, imageUrl) {
    if (!process.env.PINATA_JWT) {
        throw new Error("PINATA_JWT environment variable is missing.");
    }

    const url = `https://api.pinata.cloud/pinning/pinJSONToIPFS`;
    
    const jsonBody = {
        name: metadata.name,
        symbol: metadata.ticker,
        description: metadata.description,
        image: imageUrl, 
        showName: true,
        createdOn: "https://pump.fun",
        twitter: metadata.twitter || undefined,
        website: metadata.website || undefined,
        telegram: metadata.telegram || undefined,
        attributes: [
            { trait_type: "Creator", value: DEV_WALLET_ADDRESS },
            { trait_type: "Mode", value: metadata.isMayhemMode === 'true' ? "Mayhem V2" : "Standard V2" }
        ].filter(attr => attr.value !== undefined) 
    };

    try {
        const response = await axios.post(url, jsonBody, {
            headers: {
                'Authorization': `Bearer ${process.env.PINATA_JWT}`,
                'Content-Type': 'application/json'
            }
        });
        const ipfsHash = response.data.IpfsHash;
        console.log("Metadata JSON uploaded to Pinata:", ipfsHash);
        return `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;
    } catch (error) {
        console.error("IPFS Metadata Upload Error:", error.response?.data || error.message);
        throw new Error("Failed to upload metadata to Pinata.");
    }
}


// --- HELPER: Verify User Payment (Unchanged functionality) ---
async function verifyPayment(signature) {
    if (processedSignatures.has(signature)) {
        throw new Error("Transaction already processed (replay detected)");
    }

    const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed' });
    
    if (!tx) throw new Error("Payment transaction not found or not confirmed yet");
    if (tx.meta.err) throw new Error("Payment transaction failed on-chain");

    const myAddress = walletKeyPair.publicKey.toString();
    const accountIndex = tx.transaction.message.accountKeys.findIndex(
        account => account.pubkey.toString() === myAddress
    );
    
    if (accountIndex === -1) throw new Error("Dev wallet not found in the payment transaction accounts.");

    const preBalance = tx.meta.preBalances[accountIndex];
    const postBalance = tx.meta.postBalances[accountIndex];
    const amountReceived = (postBalance - preBalance) / LAMPORTS_PER_SOL;

    if (amountReceived < FEE_AMOUNT_SOL * 0.99) { 
        throw new Error(`Insufficient payment. Received: ${amountReceived.toFixed(4)} SOL, Expected: ${FEE_AMOUNT_SOL} SOL.`);
    }

    processedSignatures.add(signature);
    return true;
}

// --- CORE LOGIC: COLLECT FEES LOOP (Unchanged functionality) ---
async function collectCreatorFees() {
    const creatorPubkey = wallet.publicKey;

    try {
        const [creatorVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
            PUMP_PROGRAM_ID
        );

        const balance = await connection.getBalance(creatorVault);

        if (balance < 1000) { 
            return;
        }

        const solAmount = balance / LAMPORTS_PER_SOL;
        
        const [eventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("__event_authority")],
            PUMP_PROGRAM_ID
        );
        
        const ix = await program.methods
            .collectCreatorFee()
            .accounts({
                creator: creatorPubkey, 
                creatorVault: creatorVault,
                systemProgram: SYSTEM_PROGRAM_ID,
                eventAuthority: eventAuthority,
                program: PUMP_PROGRAM_ID,
            })
            .instruction();

        const transaction = new Transaction().add(ix);
        transaction.feePayer = creatorPubkey;
        
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        
        const sig = await sendAndConfirmTransaction(connection, transaction, [walletKeyPair], { 
            commitment: 'confirmed',
            skipPreflight: true 
        });

        console.log(`[Fee Collector] ✅ Collected ${solAmount.toFixed(6)} SOL. Tx: ${sig.slice(0, 10)}...`);

    } catch (error) {
        console.error(`[Fee Collector] 🚨 Error during fee collection: ${error.message}`);
    }
}

// Start the fee collection loop (1 minute interval)
const FEE_COLLECTION_INTERVAL = 60 * 1000; // 60 seconds
setInterval(collectCreatorFees, FEE_COLLECTION_INTERVAL);
collectCreatorFees(); // Run once immediately on startup

// --- CORE TRADE LOGIC: BUY (MANUAL WEB3.JS INSTRUCTION) ---
async function buyInitialSupply(mintPubkey, bondingCurvePubkey) {
    const buyAmountLamports = Math.floor(STATIC_BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);
    
    console.log(`[Dev Buy] Initiating ${STATIC_BUY_AMOUNT_SOL} SOL purchase...`);
    
    // 1. Calculate required PDAs and ATAs
    const associatedUser = await getAssociatedTokenAddress(
        mintPubkey,
        creatorPubkey,
        false, 
        TOKEN_2022_PROGRAM_ID
    );

    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        PUMP_PROGRAM_ID
    );
    
    const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), creatorPubkey.toBuffer()],
        PUMP_PROGRAM_ID
    );

    const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
        PUMP_PROGRAM_ID
    );
    
    const instructions = [];

    // 1. Create ATA if needed
    try {
        await getAccount(connection, associatedUser);
    } catch (e) {
        console.log("[Dev Buy] Creating Dev Wallet ATA for new token...");
        instructions.push(
            createAssociatedTokenAccountInstruction(
                creatorPubkey, 
                associatedUser, 
                creatorPubkey, 
                mintPubkey, 
                TOKEN_2022_PROGRAM_ID, 
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
    }
    
    // 2. Buy Instruction (Manually Encoded)
    const data = encodeBuyInstructionData(buyAmountLamports, 1, true); // (SOL in, Min Tokens out, Track Volume)

    const keys = [
        { pubkey: GLOBAL_PDA, isWritable: false, isSigner: false },
        { pubkey: creatorPubkey, isWritable: true, isSigner: false }, // feeRecipient (Dev Wallet)
        { pubkey: mintPubkey, isWritable: false, isSigner: false },
        { pubkey: bondingCurvePubkey, isWritable: true, isSigner: false },
        { pubkey: await getAssociatedTokenAddress(mintPubkey, bondingCurvePubkey, true, TOKEN_2022_PROGRAM_ID), isWritable: true, isSigner: false }, // associatedBondingCurve
        { pubkey: associatedUser, isWritable: true, isSigner: false }, // associatedUser (Dev Wallet ATA)
        { pubkey: creatorPubkey, isWritable: true, isSigner: true }, // user (Payer)
        { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: creatorVault, isWritable: true, isSigner: false },
        { pubkey: (await PublicKey.findProgramAddress([Buffer.from("__event_authority")], PUMP_PROGRAM_ID))[0], isWritable: false, isSigner: false },
        { pubkey: PUMP_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: globalVolumeAccumulator, isWritable: false, isSigner: false },
        { pubkey: userVolumeAccumulator, isWritable: true, isSigner: false },
        { pubkey: (await PublicKey.findProgramAddress([Buffer.from("fee_config"), PUMP_PROGRAM_ID.toBuffer()], FEE_PROGRAM_ID))[0], isWritable: false, isSigner: false },
        { pubkey: FEE_PROGRAM_ID, isWritable: false, isSigner: false },
    ];

    instructions.push(new TransactionInstruction({
        keys,
        programId: PUMP_PROGRAM_ID,
        data,
    }));

    // 3. Send Transaction
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = creatorPubkey;
    
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    
    const buySig = await sendAndConfirmTransaction(connection, transaction, [walletKeyPair], { 
        commitment: 'confirmed',
        skipPreflight: true 
    });

    console.log(`[Dev Buy] ✅ Purchase confirmed. Tx: ${buySig}`);
    return { signature: buySig, ata: associatedUser };
}


// --- CORE TRADE LOGIC: SELL (MANUAL WEB3.JS INSTRUCTION) ---
async function sellAllTokens(mintPubkey, bondingCurvePubkey, associatedUserPubkey) {
    console.log("[Dev Sell] Calculating balance for full sell...");

    const tokenBalanceBN = await getTokenBalance(mintPubkey); 

    if (tokenBalanceBN === 0n) {
        console.log("[Dev Sell] Wallet holds zero tokens. Skipping sell.");
        return "N/A (Zero Balance)";
    }
    
    console.log(`[Dev Sell] Balance: ${tokenBalanceBN.toString()} tokens. Executing full sell...`);

    // 1. Setup PDAs
    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        PUMP_PROGRAM_ID
    );
    
    const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), creatorPubkey.toBuffer()],
        PUMP_PROGRAM_ID
    );

    const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
        PUMP_PROGRAM_ID
    );
    
    // 2. Sell Instruction (Manually Encoded)
    const data = encodeSellInstructionData(tokenBalanceBN, 1, true); // (Tokens in, Min SOL out, Track Volume)

    const keys = [
        { pubkey: GLOBAL_PDA, isWritable: false, isSigner: false },
        { pubkey: creatorPubkey, isWritable: true, isSigner: false }, // feeRecipient (Dev Wallet)
        { pubkey: mintPubkey, isWritable: false, isSigner: false },
        { pubkey: bondingCurvePubkey, isWritable: true, isSigner: false },
        { pubkey: await getAssociatedTokenAddress(mintPubkey, bondingCurvePubkey, true, TOKEN_2022_PROGRAM_ID), isWritable: true, isSigner: false }, // associatedBondingCurve
        { pubkey: associatedUserPubkey, isWritable: true, isSigner: false }, // associatedUser (Dev Wallet ATA)
        { pubkey: creatorPubkey, isWritable: true, isSigner: true }, // user (Payer)
        { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: creatorVault, isWritable: true, isSigner: false },
        { pubkey: (await PublicKey.findProgramAddress([Buffer.from("__event_authority")], PUMP_PROGRAM_ID))[0], isWritable: false, isSigner: false },
        { pubkey: PUMP_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: globalVolumeAccumulator, isWritable: false, isSigner: false },
        { pubkey: userVolumeAccumulator, isWritable: true, isSigner: false },
        { pubkey: (await PublicKey.findProgramAddress([Buffer.from("fee_config"), PUMP_PROGRAM_ID.toBuffer()], FEE_PROGRAM_ID))[0], isWritable: false, isSigner: false },
        { pubkey: FEE_PROGRAM_ID, isWritable: false, isSigner: false },
    ];

    const transaction = new Transaction().add(new TransactionInstruction({
        keys,
        programId: PUMP_PROGRAM_ID,
        data,
    }));

    // 3. Send Transaction
    transaction.feePayer = creatorPubkey;
    
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    
    const sellSig = await sendAndConfirmTransaction(connection, transaction, [walletKeyPair], { 
        commitment: 'confirmed',
            skipPreflight: true 
        });

    console.log(`[Dev Sell] ✅ Sell confirmed. Tx: ${sellSig}`);
    return sellSig;
}


// --- MAIN ENDPOINT: Deploy Token ---
app.post('/deploy', upload.single('imageFile'), async (req, res) => {
    try {
        if (!req.file || req.file.fieldname !== 'imageFile') {
            return res.status(400).json({ success: false, error: 'Image file upload failed or missing. Did you select a file?' });
        }
        
        const { 
            name, 
            ticker, 
            paymentSignature, 
            isMayhemMode 
        } = req.body;
        
        // 🚨 CRITICAL RISK MITIGATION STEP: Check content safety
        // 
        await checkContentSafety(req.file.buffer, req.file.mimetype);

        // --- 1. VERIFY PAYMENT ---
        await verifyPayment(paymentSignature);

        // --- 2. IPFS UPLOAD FLOW (Backend) ---
        
        const imageUrl = await uploadFileToPinata(req.file, ticker);
        const metadataUri = await uploadMetadataToIPFS(req.body, imageUrl);

        // --- 3. EXECUTE DEPLOYMENT (Transaction 1: Create V2) ---
        const mintKeypair = Keypair.generate();
        
        const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
        const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID);
        const associatedBondingCurve = await getAssociatedTokenAddress(mintKeypair.publicKey, bondingCurve, true, TOKEN_2022_PROGRAM_ID);
        const [mayhemState] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mintKeypair.publicKey.toBuffer()], MAYHEM_PROGRAM_ID);
        const mayhemTokenVault = await getAssociatedTokenAddress(mintKeypair.publicKey, SOL_VAULT_PUBKEY, true, TOKEN_2022_PROGRAM_ID);
        const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);
        const isMayhem = isMayhemMode === 'true';
        
        console.log("[Deployment] Sending createV2 transaction...");
        
        const deployTxSig = await program.methods
            .createV2(name, ticker, metadataUri, creatorPubkey, isMayhem) 
            .accounts({
                mint: mintKeypair.publicKey,
                mintAuthority: mintAuthority,
                bondingCurve: bondingCurve,
                associatedBondingCurve: associatedBondingCurve,
                global: GLOBAL_PDA,
                user: creatorPubkey,
                systemProgram: SYSTEM_PROGRAM_ID,
                tokenProgram: TOKEN_2022_PROGRAM_ID, 
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                mayhemProgramId: MAYHEM_PROGRAM_ID,
                globalParams: GLOBAL_PARAMS_PUBKEY,
                solVault: SOL_VAULT_PUBKEY,
                mayhemState: mayhemState,
                mayhemTokenVault: mayhemTokenVault,
                eventAuthority: eventAuthority,
                program: PUMP_PROGRAM_ID,
            })
            .signers([mintKeypair, walletKeyPair]) 
            .rpc();

        console.log("[Deployment] Token Deployed! Signature:", deployTxSig);
        
        let buyTxSig = "N/A";
        let sellTxSig = "N/A";
        
        // --- 4. EXECUTE INITIAL BUY (Transaction 2) ---
        const { signature: initialBuySig, ata: associatedUserPubkey } = await buyInitialSupply(
            mintKeypair.publicKey, 
            bondingCurve
        );
        buyTxSig = initialBuySig;
        
        // --- 5. WAIT 1 SECOND ---
        console.log(`[Trade] Waiting 1 second...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // --- 6. EXECUTE SELL (Transaction 3) ---
        sellTxSig = await sellAllTokens(
            mintKeypair.publicKey, 
            bondingCurve, 
            associatedUserPubkey
        );
        
        res.json({
            success: true,
            mintAddress: mintKeypair.publicKey.toString(),
            deployTransactionSignature: deployTxSig,
            buyTransactionSignature: buyTxSig,
            sellTransactionSignature: sellTxSig,
            pumpUrl: `https://pump.fun/${mintKeypair.publicKey.toString()}`
        });

    } catch (error) {
        console.error("Deployment Failed:", error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Pump.fun Backend Service running on port ${PORT}. RPC: ${RPC_ENDPOINT.slice(0, 20)}...`);
});
