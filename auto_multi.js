const ethers = require('ethers');
const axios = require('axios');
const fs = require('fs');
const readline = require('readline');
const banner = require('./banner.js');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const mysql = require('mysql2/promise');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

console.log(banner);

const API_BASE_URL = 'https://api.fireverseai.com';
const WEB3_URL = 'https://web3.fireverseai.com';
const APP_URL = 'https://app.fireverseai.com';

const DEFAULT_HEADERS = {
    'accept': 'application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'en-US,en;q=0.9',
    'origin': WEB3_URL,
    'referer': `${WEB3_URL}/`,
    'sec-ch-ua': '"Not(A:Brand";v="99", "Microsoft Edge";v="133", "Chromium";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
};

const CONFIG = {
    BATCH_SIZE: 30,
    NUM_WORKERS: 30,
    START_OFFSET: 0,
    PROCESS_AMOUNT: 90,
    WORKER_DELAY: 1,
    WALLET_DELAY: 1,
    WORKER_TIMEOUT: 3600*12  // Increase timeout to 12 hours
};

const DB_CONFIG = {
    host: 'localhost',
    user: 'ledge',
    password: 'hfLEsAtStG4LzETZ',
    database: 'ledge'
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

function loadProxies() {
    try {
        if (fs.existsSync('proxy.txt')) {
            const proxyList = fs.readFileSync('proxy.txt', 'utf8')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            
            return proxyList.map(proxy => {
                const [url, type = 'http'] = proxy.split('#').map(p => p.trim());
                return { url, type: type.toLowerCase() };
            });
        }
        return [];
    } catch (error) {
        console.log('⚠️ Error loading proxies:', error.message);
        return [];
    }
}

function createAxiosInstance(proxy = null) {
    const config = {
        timeout: 30000,
        headers: DEFAULT_HEADERS
    };

    if (proxy) {
        const { url, type } = proxy;
        try {
            switch (type) {
                case 'http':
                case 'https':
                    config.httpsAgent = new HttpsProxyAgent(url);
                    break;
                case 'socks4':
                case 'socks5':
                    config.httpsAgent = new SocksProxyAgent(url);
                    break;
            }
        } catch (error) {
            console.log(`⚠️ Error creating proxy agent: ${error.message}`);
            // Continue without proxy if there's an error
        }
    }

    return axios.create(config);
}

function getTimestamp() {
    return `[${new Date().toLocaleTimeString()}]`;
}

class FireverseMusicBot {
    constructor(token, accountIndex, proxy = null, totalAccounts = 1) {
        this.baseUrl = API_BASE_URL;
        this.token = token;
        this.accountIndex = accountIndex;
        this.totalAccounts = totalAccounts;
        this.playedSongs = new Set();
        this.songsToPlay = 50;
        this.songCount = 0;
        this.totalListeningTime = 0;
        this.lastHeartbeat = Date.now();
        this.headers = {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.8',
            'content-type': 'application/json',
            'origin': APP_URL,
            'referer': `${APP_URL}/`,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'x-version': '1.0.100',
            'token': token
        };
        this.axios = createAxiosInstance(proxy);
    }

    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    log(message, overwrite = false) {
        const prefix = `${getTimestamp()} [Account ${this.accountIndex}/${this.totalAccounts}] `;
        if (overwrite) {
            process.stdout.write(`\r${prefix}${message}`);
        } else {
            console.log(`${prefix}${message}`);
        }
    }

    async initialize() {
        try {
            await this.getUserInfo();
            return true;
        } catch (error) {
            this.log('Error initializing bot: ' + error.message);
            return false;
        }
    }

    async getUserInfo() {
        try {
            const response = await this.axios.get(
                `${this.baseUrl}/userInfo/getMyInfo`,
                { headers: this.headers }
            );
            const { level, expValue, score } = response.data.data;
            this.log(`Level: ${level} | Score: ${score} | EXP: ${expValue}`);
            return response.data.data;
        } catch (error) {
            this.log('Error getting user info: ' + error.message);
            return null;
        }
    }

    async getRecommendedSongs() {
        try {
            const response = await this.axios.post(
                `${this.baseUrl}/home/getRecommend`,
                { type: 1 },
                { headers: this.headers }
            );
            return response.data?.data || [];
        } catch (error) {
            this.log('Error getting recommended songs: ' + error.message);
            return [];
        }
    }

    async getMusicDetails(musicId) {
        try {
            const response = await this.axios.get(
                `${this.baseUrl}/music/getDetailById?musicId=${musicId}`,
                { headers: this.headers }
            );
            return response.data?.data;
        } catch (error) {
            this.log('Error getting music details: ' + error.message);
            return null;
        }
    }

    async sendHeartbeat() {
        try {
            const now = Date.now();
            if (now - this.lastHeartbeat >= 30000) {
                await this.axios.post(
                    `${this.baseUrl}/music/userOnlineTime/receiveHeartbeat`,
                    {},
                    { headers: this.headers }
                );
                this.lastHeartbeat = now;
                process.stdout.write('💓');
            }
        } catch (error) {
            // Silent heartbeat errors
        }
    }

    async playMusic(musicId) {
        try {
            await this.axios.post(
                `${this.baseUrl}/musicUserBehavior/playEvent`,
                { musicId, event: 'playing' },
                { headers: this.headers }
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    async endMusic(musicId) {
        try {
            await this.axios.post(
                `${this.baseUrl}/musicUserBehavior/playEvent`,
                { musicId, event: 'playEnd' },
                { headers: this.headers }
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    async likeMusic(musicId) {
        try {
            await this.axios.post(
                `${this.baseUrl}/musicMyFavorite/addToMyFavorite?musicId=${musicId}`,
                {},
                { headers: this.headers }
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    async commentMusic(musicId) {
        try {
            const comments = [
                "Great song!",
                "Amazing tune!",
                "Love this!",
                "Fantastic music!",
                "Wonderful piece!"
            ];
            const randomComment = comments[Math.floor(Math.random() * comments.length)];
            
            await this.axios.post(
                `${this.baseUrl}/musicComment/addComment`,
                {
                    content: randomComment,
                    musicId,
                    parentId: 0,
                    rootId: 0
                },
                { headers: this.headers }
            );
            return true;
        } catch (error) {
            return false;
        }
    }

    async processMusic(song) {
        try {
            this.log(`\n▶️ Now Playing: ${song.musicName}`);
            this.log(`👤 Artist: ${song.author || 'Unknown'}`);
            
            const musicDetails = await this.getMusicDetails(song.id);
            const duration = musicDetails?.duration || song.duration || 180;
            this.log(`⏱️ Duration: ${this.formatTime(duration)}`);
            
            if (await this.playMusic(song.id)) {
                await this.likeMusic(song.id);
                this.log('❤️ Liked the song');
                
                await this.commentMusic(song.id);
                this.log('💬 Commented on the song');
                
                let secondsPlayed = 0;
                for (let timeLeft = duration; timeLeft > 0; timeLeft--) {
                    await this.sendHeartbeat();
                    secondsPlayed++;
                    this.totalListeningTime++;
                    
                    this.log(`⏳ Time remaining: ${this.formatTime(timeLeft)} | Total listening time: ${this.formatTime(this.totalListeningTime)}`, true);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
                await this.endMusic(song.id);
                this.log('\n✅ Finished playing');
                return true;
            }
            return false;
        } catch (error) {
            this.log('Error processing music: ' + error.message);
            return false;
        }
    }

    async performTasks() {
        try {
            const songs = await this.getRecommendedSongs();
            
            for (const song of songs) {
                if (this.songCount >= this.songsToPlay) break;
                if (this.playedSongs.has(song.id)) continue;

                this.playedSongs.add(song.id);
                await this.processMusic(song);
                this.songCount++;
                
                this.log(`\n📊 Progress: ${this.songCount}/${this.songsToPlay} songs completed`);
                this.log(`🎵 Total listening time: ${this.formatTime(this.totalListeningTime)}`);
                
                await this.getUserInfo();
                
                if (this.songCount < this.songsToPlay) {
                    this.log('\n⏳ Waiting 5 seconds before next song...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
            
            this.log('\n🎉 Completed all tasks!');
            this.log(`📊 Final Statistics:`);
            this.log(`🎵 Songs Played: ${this.songCount}`);
            this.log(`⏱️ Total Listening Time: ${this.formatTime(this.totalListeningTime)}`);
        } catch (error) {
            this.log('Error performing tasks: ' + error.message);
        }
    }
}

// Remove the generateWallet function as we're using DB data

async function getSession(axiosInstance) {
    try {
        const response = await axiosInstance.get(`${API_BASE_URL}/walletConnect/getSession`);
        return response.data.data;
    } catch (error) {
        console.error('Error getting session:', error);
        return null;
    }
}

async function getNonce(axiosInstance) {
    try {
        const response = await axiosInstance.get(`${API_BASE_URL}/walletConnect/nonce`);
        return response.data.data.nonce;
    } catch (error) {
        console.error('Error getting nonce:', error);
        return null;
    }
}

async function signMessage(wallet, nonce) {
    const messageToSign = `web3.fireverseai.com wants you to sign in with your Ethereum account:\n${wallet.address}\n\nPlease sign with your account\n\nURI: https://web3.fireverseai.com\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    
    const privateKey = wallet.privateKey.startsWith('0x') ? wallet.privateKey : `0x${wallet.privateKey}`;
    const signingKey = new ethers.SigningKey(privateKey);
    const messageHash = ethers.hashMessage(messageToSign);
    const signature = signingKey.sign(messageHash);
    
    return {
        message: messageToSign,
        signature: signature.serialized
    };
}

async function verifyWallet(axiosInstance, message, signature, inviteCode) {
    try {
        const response = await axiosInstance.post(
            `${API_BASE_URL}/walletConnect/verify`,
            {
                message,
                signature,
                wallet: "bee",
                invitationCode: inviteCode
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error verifying wallet:', error);
        return null;
    }
}

async function processWalletAndTasks(wallet, inviteCode, outputStream, index, total, proxy = null) {
    const indexStr = `${index + 1}/${total}`;
    const timestamp = getTimestamp();
    console.log(`\n${timestamp} 🔄 Processing wallet ${indexStr}`);
    console.log(`${timestamp} [${indexStr}] 📝 Generated address: ${wallet.address}`);
    if (proxy) {
        console.log(`${timestamp} [${indexStr}] 🌐 Using proxy: ${proxy.url} (${proxy.type})`);
    } else {
        console.log(`${timestamp} [${indexStr}] 🌐 No proxy in use`);
    }

    const axiosInstance = createAxiosInstance(proxy);

    const session = await getSession(axiosInstance);
    if (!session) {
        console.log(`${timestamp} [${indexStr}] ❌ Failed to get session`);
        return false;
    }

    const nonce = await getNonce(axiosInstance);
    if (!nonce) {
        console.log(`${timestamp} [${indexStr}] ❌ Failed to get nonce`);
        return false;
    }

    const { message, signature } = await signMessage(wallet, nonce);
    const verifyResult = await verifyWallet(axiosInstance, message, signature, inviteCode);
    
    if (verifyResult?.success) {
        const walletInfo = `${timestamp} Wallet ${indexStr}\nAddress: ${wallet.address}\nPrivate Key: ${wallet.privateKey}\nVerification Status: Success\nSession ID: ${session.sessionId}\nToken: ${verifyResult.data.token}\n------------------------\n`;
        outputStream.write(walletInfo);
        console.log(`${timestamp} [${indexStr}] ✅ Wallet successfully verified and saved`);

        // Wait a short time before starting music tasks
        await new Promise(resolve => setTimeout(resolve, 1000));

        const bot = new FireverseMusicBot(verifyResult.data.token, index + 1, proxy, total);
        if (await bot.initialize()) {
            console.log(`${timestamp} [${indexStr}] 🎵 Starting music tasks...`);
            await bot.performTasks();
        }

        return true;
    } else {
        console.log(`${timestamp} [${indexStr}] ❌ Wallet verification failed`);
        return false;
    }
}

// Update worker function to process wallets sequentially
async function workerFunction({ wallets, proxies, inviteCode, startIndex, totalWallets }) {
    const outputStream = fs.createWriteStream('generated_wallets.txt', { flags: 'a' });
    let successCount = 0;

    // Process wallets one at a time
    for (let i = 0; i < wallets.length; i++) {
        const globalIndex = startIndex + i;
        const proxy = proxies.length > 0 ? proxies[globalIndex % proxies.length] : null;
        const success = await processWalletAndTasks(wallets[i], inviteCode, outputStream, globalIndex, totalWallets, proxy);
        if (success) successCount++;
        
        // Add delay between wallets if not the last one
        if (i < wallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.WALLET_DELAY * 1000));
        }
    }

    outputStream.end();
    parentPort.postMessage({ successCount });
}

if (!isMainThread) {
    workerFunction(workerData);
}

async function loadWalletsFromDB(offset, limit) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        const [rows] = await connection.execute(
            'SELECT address, privatekey FROM wallets LIMIT ? OFFSET ?',
            [limit, offset]
        );
        return rows.map(row => ({
            address: row.address,
            privateKey: row.privatekey
        }));
    } finally {
        await connection.end();
    }
}

// Main function to manage workers
async function main() {
    if (!isMainThread) return;

    try {
        const timestamp = getTimestamp();
        console.log(`${timestamp} 🎵 Auto Gen + Auto Task with Worker Queue 🎵`);
        console.log(`${timestamp} -----------------------------------------------------`);

        const numWallets = CONFIG.PROCESS_AMOUNT;
        console.log(`\n${timestamp} 🔄 Processing ${numWallets} wallets...`);

        // Load proxies from file
        const proxies = loadProxies();
        console.log(`${timestamp} 📡 Loaded ${proxies.length} proxies from proxy.txt`);

        // Continuous loop
        while (true) {
            const totalBatches = Math.ceil(numWallets / CONFIG.BATCH_SIZE);
            let totalSuccessCount = 0;

            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                const batchStart = batchNum * CONFIG.BATCH_SIZE;
                const batchSize = Math.min(CONFIG.BATCH_SIZE, numWallets - batchStart);
                
                console.log(`\n${timestamp} 📦 Processing batch ${batchNum + 1}/${totalBatches}...`);
                
                const wallets = await loadWalletsFromDB(batchStart, batchSize);
                if (wallets.length === 0) break;

                const workerPromises = [];
                const walletsPerWorker = Math.ceil(wallets.length / CONFIG.NUM_WORKERS);

                for (let i = 0; i < CONFIG.NUM_WORKERS; i++) {
                    const startIndex = i * walletsPerWorker;
                    const workerWallets = wallets.slice(startIndex, startIndex + walletsPerWorker);
                    if (workerWallets.length > 0) {
                        workerPromises.push(new Promise((resolve, reject) => {
                            const worker = new Worker(__filename, {
                                workerData: { 
                                    wallets: workerWallets, 
                                    proxies, 
                                    inviteCode: "8I7HIA",
                                    startIndex: batchStart + startIndex,
                                    totalWallets: numWallets
                                }
                            });
                            worker.on('message', resolve);
                            worker.on('error', reject);
                            worker.on('exit', code => {
                                if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
                            });
                        }));
                    }
                }

                try {
                    const results = await Promise.all(workerPromises);
                    const batchSuccessCount = results.reduce((acc, result) => acc + result.successCount, 0);
                    totalSuccessCount += batchSuccessCount;

                    console.log(`\n${timestamp} ✅ Batch ${batchNum + 1} completed: ${batchSuccessCount}/${wallets.length} successful`);
                    
                    if (batchNum < totalBatches - 1) {
                        console.log(`\n${timestamp} ⏳ Waiting ${CONFIG.WORKER_DELAY}s before next batch...`);
                        await new Promise(resolve => setTimeout(resolve, CONFIG.WORKER_DELAY * 1000));
                    }
                } catch (error) {
                    console.error(`${timestamp} ❌ Batch ${batchNum + 1} error:`, error);
                }
            }

            console.log(`\n${timestamp} 🔄 Cycle completed! Starting over from batch 1...`);
            console.log(`${timestamp} ⏳ Waiting 60 seconds before starting next cycle...`);
            await new Promise(resolve => setTimeout(resolve, 60000)); // 1-minute delay between cycles
        }
    } catch (error) {
        const timestamp = getTimestamp();
        console.error(`${timestamp} ❌ Fatal error:`, error);
        process.exit(1);
    } finally {
        rl.close();
    }
}

// Setup process handlers
process.on('unhandledRejection', (error) => {
    console.error(`${getTimestamp()} ❌ Unhandled Rejection:`, error);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error(`${getTimestamp()} ❌ Uncaught Exception:`, error);
    process.exit(1);
});

main();