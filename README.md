# ASDF Launcher

Token launcher for Solana. Ships tokens that end with `ASDF`. That's it.

## Requirements

- Node.js 18+
- Redis
- A Solana wallet with some SOL
- Coffee (optional but recommended)

## Installation

```bash
# Clone the thing
git clone https://github.com/zeyxx/ASDev.git
cd ASDev

# Install dependencies
npm install

# Copy the env file and fill it in
cp .env.example .env
```

## Configuration

Create a `.env` file:

```env
# Required
DEV_WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://api.mainnet-beta.solana.com

# Optional but nice to have
HELIUS_API_KEY=your_helius_key
PORT=3000

# Vanity grinder (for ASDF addresses)
VANITY_GRINDER_ENABLED=true
VANITY_GRINDER_URL=http://localhost:8080
VANITY_GRINDER_API_KEY=your_api_key

# Twitter (if you want social features)
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...
```

## Running

### The easy way

```bash
npm start
```

### The fancy way (with vanity grinder)

```bash
# Start Redis first
redis-server --daemonize yes

# Start the vanity grinder (in asdf-vanity-grinder folder)
cd asdf-vanity-grinder
./target/release/asdf-vanity-grinder pool \
  --file vanity_pool.json \
  --port 8080 \
  --api-key your_api_key \
  --min-pool 10 \
  --threads 2

# Back to main folder, start the server
cd ..
VANITY_GRINDER_ENABLED=true npm start
```

### The lazy way

```bash
VANITY_GRINDER_ENABLED=true ./scripts/start.sh
```

## API Endpoints

| Endpoint | What it does |
|----------|--------------|
| `GET /api/health` | Is it alive? |
| `GET /api/version` | What version? |
| `GET /api/blockhash` | Fresh blockhash |
| `GET /api/leaderboard` | Top tokens |
| `GET /api/recent-launches` | Recent tokens |
| `POST /api/prep-create-coin` | Prepare token launch |
| `POST /api/sign-tx` | Sign and send transaction |

## Project Structure

```
src/
├── index.js          # Entry point
├── config/           # Configuration
├── services/         # Core services (solana, redis, etc.)
├── routes/           # API endpoints
└── tasks/            # Background jobs
```

## Vanity Grinder

The Rust vanity grinder generates Solana keypairs ending with `ASDF`. It runs separately and the Node.js server fetches keypairs from it via HTTP.

```bash
cd asdf-vanity-grinder
cargo build --release
```

## Troubleshooting

**Server won't start?**
- Check if Redis is running: `redis-cli ping`
- Check your `.env` file
- Check if port 3000 is free

**Vanity grinder not working?**
- Is it running? `pgrep -f asdf-vanity-grinder`
- Is the API key correct?
- Check `http://localhost:8080/health`

**Everything is on fire?**
- This is fine.

## License

Do whatever you want with it.
