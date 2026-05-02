import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update } from "firebase/database";

// Updated Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyCvzeg8_7ym5QYcDcfKbtC09JM0GkCVDn8",
  authDomain: "swiftpay-459cb.firebaseapp.com",
  databaseURL: "https://swiftpay-459cb-default-rtdb.firebaseio.com",
  projectId: "swiftpay-459cb",
  storageBucket: "swiftpay-459cb.firebasestorage.app",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Your specific Bot Token
const BOT_TOKEN = "8440520277:AAG-DcrzOHZ2jFtvMofUdgxK2ATPFvdwkwM";

async function sendTelegramMsg(chatId, text) {
    try {
        if (!chatId) return false;
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });
        return response.ok;
    } catch (e) { 
        console.error("Telegram Error:", e);
        return false; 
    }
}

export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { key, paytm, amount, number } = req.query;
        
        let rawKey = String(key || "").trim();
        const withdrawAmount = parseFloat(amount);
        
        // 🚨 STRICT CLEANUP: Remove any spaces, +91, or special characters to strictly match numbers
        const targetNumber = String(paytm || number || "").replace(/[^0-9]/g, ""); 

        // --- SMART KEY EXTRACTION ---
        let safeKey = rawKey;
        if (rawKey.includes("http") && rawKey.includes("key=")) {
            const urlMatch = rawKey.match(/key=(SP-[a-zA-Z0-9]+)/i);
            if (urlMatch) safeKey = urlMatch[1].toUpperCase();
        } else {
            const cleanMatch = rawKey.match(/(SP-[a-zA-Z0-9]{6,15})/i);
            if (cleanMatch) safeKey = cleanMatch[1].toUpperCase();
        }

        if (!safeKey) {
            return res.status(400).json({ status: "error", message: "Missing API Key!" });
        }

        if (/[.#$\[\]\/]/.test(safeKey)) {
            return res.status(401).json({ status: "error", message: "Invalid API Key format!" });
        }

        // Fast API verification
        const apiKeySnap = await get(ref(db, `api_keys/${safeKey}`));
        
        if (!apiKeySnap.exists()) {
            return res.status(401).json({ status: "error", message: "Invalid API Key! Old key is expired or incorrect." });
        }

        // 🚨 STRICT CLEANUP: Clean admin phone before check
        const adminPhone = String(apiKeySnap.val()).replace(/[^0-9]/g, "");
        
        // 1. 🚨 STRICT SELF-TRANSFER BAN
        if (adminPhone === targetNumber) {
            return res.status(400).json({ status: "error", message: "Self-transfer is strictly not allowed!" });
        }

        // 2. Parameter Validation
        if (!targetNumber || !amount) {
            return res.status(400).json({ status: "error", message: "Target number and amount are required." });
        }

        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            return res.status(400).json({ status: "error", message: "Invalid amount provided!" });
        }

        // Admin data fetch
        const adminSnap = await get(ref(db, `users/${adminPhone}`));
        if (!adminSnap.exists()) {
            return res.status(401).json({ status: "error", message: "Admin account not found!" });
        }
        let adminData = adminSnap.val() || {};

        // 3. Balance Validation (Admin)
        const currentAdminBal = parseFloat(adminData.balance) || 0;
        if (currentAdminBal < withdrawAmount) {
            return res.status(400).json({ status: "error", message: "Insufficient balance in Swift Pay wallet!" });
        }

        // 4. Receiver Validation & Get Current Balance
        const receiverSnap = await get(ref(db, `users/${targetNumber}`));
        if (!receiverSnap.exists()) {
            return res.status(404).json({ status: "error", message: "Receiver is not a registered Swift Pay user!" });
        }
        let receiverData = receiverSnap.val() || {};
        const currentReceiverBal = parseFloat(receiverData.balance) || 0;

        // 5. Transaction Process
        const exactDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const txnId = "TXN" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

        const updates = {};
        
        // ✨ EXACT CALCULATION
        const exactNewAdminBal = currentAdminBal - withdrawAmount;
        const exactNewReceiverBal = currentReceiverBal + withdrawAmount;

        updates[`users/${adminPhone}/balance`] = exactNewAdminBal;
        updates[`users/${targetNumber}/balance`] = exactNewReceiverBal;

        // Record Transaction
        updates[`transactions/${txnId}`] = { 
            id: txnId, 
            type: "out", 
            title: "Swift Pay API", 
            amount: withdrawAmount, 
            status: "Success", 
            date: exactDate, 
            timestamp: Date.now(), 
            icon: "fa-bolt", 
            color: "blue", 
            name: receiverData.name || targetNumber, 
            number: targetNumber,
            senderName: adminData.name || adminPhone,
            senderId: adminPhone, 
            receiverId: targetNumber,
            isApi: true
        };

        // Execute all updates simultaneously
        await update(ref(db), updates);

        // 6. Notifications
        const rName = receiverData.name || targetNumber;
        const aName = adminData.name || adminPhone;
        
        if (adminData.tgUserId) {
            await sendTelegramMsg(adminData.tgUserId, `🚀 Swift Pay: API Payment Sent!\nTo: ${rName}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }
        if (receiverData.tgUserId) {
            await sendTelegramMsg(receiverData.tgUserId, `💰 Swift Pay: API Payment Received!\nFrom: ${aName}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }

        return res.status(200).json({ 
            status: "success", 
            message: `Payment successful to ${targetNumber} via Swift Pay`,
            data: { transaction_id: txnId, amount: withdrawAmount, receiver: targetNumber, sender: adminPhone }
        });

    } catch (error) { 
        return res.status(500).json({ status: "error", message: "Internal Server Error: " + (error.message || "Unknown") }); 
    }
}
