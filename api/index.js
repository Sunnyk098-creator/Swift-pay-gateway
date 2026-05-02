import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, query, orderByChild, equalTo, update } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCvzeg8_7ym5QYcDcfKbtC09JM0GkCVDn8",
  authDomain: "swiftpay-459cb.firebaseapp.com",
  databaseURL: "https://swiftpay-459cb-default-rtdb.firebaseio.com",
  projectId: "swiftpay-459cb",
  storageBucket: "swiftpay-459cb.firebasestorage.app",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Updated Bot Token
const BOT_TOKEN = "8440520277:AAG-DcrzOHZ2jFtvMofUdgxK2ATPFvdwkwM";

// Fast async notification
async function sendTelegramMsg(chatId, text) {
    try {
        if (!chatId) return false;
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text })
        });
        return true;
    } catch (e) { return false; }
}

// 🛡️ STRICT HELPER FUNCTION: Hamesha exact 10-digit number nikalega
const get10DigitNumber = (num) => {
    const cleaned = String(num || "").replace(/\D/g, "");
    return cleaned.slice(-10);
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { key, paytm, amount, number } = req.query;
        
        let rawKey = String(key || "").trim();
        const withdrawAmount = parseFloat(amount);
        
        // 1. SMART KEY EXTRACTION (URL se directly API key nikalna)
        let safeKey = rawKey;
        if (rawKey.includes("http") && rawKey.includes("key=")) {
            const urlMatch = rawKey.match(/key=(SP-[a-zA-Z0-9]+)/i);
            if (urlMatch) safeKey = urlMatch[1].toUpperCase();
        } else {
            const cleanMatch = rawKey.match(/(SP-[a-zA-Z0-9]{6,15})/i);
            if (cleanMatch) safeKey = cleanMatch[1].toUpperCase();
        }

        if (!safeKey) return res.status(400).json({ status: "error", message: "Missing API Key!" });
        if (/[.#$\[\]\/]/.test(safeKey)) return res.status(401).json({ status: "error", message: "Invalid API Key format!" });

        // 2. LION PAY STYLE DIRECT QUERY (No need for separate api_keys node)
        const usersRef = ref(db, "users");
        const adminSnap = await get(query(usersRef, orderByChild("apiKey"), equalTo(safeKey)));
        
        if (!adminSnap.exists()) {
            return res.status(401).json({ status: "error", message: "Invalid API Key! Old key is expired or incorrect." });
        }

        let adminPhoneRaw = null, adminData = {};
        adminSnap.forEach((child) => { 
            adminPhoneRaw = child.key; 
            adminData = child.val() || {}; 
        });

        // 3. STRICT NUMBER NORMALIZATION (To completely ban self-transfer)
        const adminPhone = get10DigitNumber(adminPhoneRaw);
        const targetNumber = get10DigitNumber(paytm || number);

        if (!adminPhone || adminPhone.length !== 10) return res.status(401).json({ status: "error", message: "Admin phone number is invalid!" });
        if (!targetNumber || targetNumber.length !== 10) return res.status(400).json({ status: "error", message: "Target phone number is invalid!" });
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) return res.status(400).json({ status: "error", message: "Invalid amount provided!" });

        // 4. 🚫 EXACT SELF-TRANSFER BAN
        if (adminPhone === targetNumber) {
            return res.status(400).json({ status: "error", message: "API Owner cannot send payment to their own number (Self-transfer not allowed)!" });
        }

        // 5. STRICT BALANCE CHECK
        const currentAdminBal = parseFloat(adminData.balance) || 0;
        if (currentAdminBal < withdrawAmount) {
            return res.status(400).json({ status: "error", message: "Insufficient Balance in API Owner's wallet!" });
        }

        // 6. CHECK IF RECEIVER EXISTS
        const receiverSnap = await get(ref(db, `users/${targetNumber}`));
        if (!receiverSnap.exists()) {
            return res.status(404).json({ status: "error", message: "Receiver mobile number is not registered in Swift Pay wallet!" });
        }
        let receiverData = receiverSnap.val() || {};
        const currentReceiverBal = parseFloat(receiverData.balance) || 0;

        // 7. 💰 EXACT MATH DEDUCTION & CREDIT (Instead of increment, fixes deduction issues)
        const exactDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const txnId = "TXN" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

        const updates = {};
        
        updates[`users/${adminPhoneRaw}/balance`] = currentAdminBal - withdrawAmount;
        updates[`users/${targetNumber}/balance`] = currentReceiverBal + withdrawAmount;

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

        // 8. 🔔 NOTIFICATIONS
        const rName = receiverData.name || targetNumber;
        const aName = adminData.name || adminPhone;
        
        if (adminData.tgUserId) {
            sendTelegramMsg(adminData.tgUserId, `🚀 Swift Pay: API Payment Sent!\nTo: ${rName}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }
        if (receiverData.tgUserId) {
            sendTelegramMsg(receiverData.tgUserId, `💰 Swift Pay: API Payment Received!\nFrom: ${aName}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }

        return res.status(200).json({ 
            status: "success", 
            message: `Payment successful to ${targetNumber}`,
            data: { transaction_id: txnId, amount: withdrawAmount, receiver: targetNumber, sender: adminPhone }
        });

    } catch (error) { 
        return res.status(500).json({ status: "error", message: "Server Error: " + (error.message || "Unknown error") }); 
    }
}
