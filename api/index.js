import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, query, orderByChild, equalTo, update, increment } from "firebase/database";

// Firebase Config for Swift Pay
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
        return false; 
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { key, paytm, amount, number } = req.query;
        const safeKey = String(key || "").trim();
        const targetNumber = String(paytm || number || "").trim(); 

        if (!safeKey) {
            return res.status(400).json({ status: "error", message: "Missing API Key!" });
        }

        const usersRef = ref(db, "users");
        const adminSnap = await get(query(usersRef, orderByChild("apiKey"), equalTo(safeKey)));
        
        if (!adminSnap.exists()) {
            return res.status(401).json({ status: "error", message: "Invalid API Key!" });
        }

        let adminPhone = null, adminData = {};
        adminSnap.forEach((child) => { 
            adminPhone = child.key; 
            adminData = child.val() || {}; 
        });

        if (!targetNumber || !amount) {
            return res.status(400).json({ status: "error", message: "Missing target number or amount." });
        }

        const withdrawAmount = Number(amount);
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            return res.status(400).json({ status: "error", message: "Invalid amount!" });
        }

        if (String(adminPhone) === targetNumber) {
            return res.status(400).json({ status: "error", message: "Self-transfer not allowed!" });
        }

        const currentAdminBal = Number(adminData.balance) || 0;
        if (currentAdminBal < withdrawAmount) {
            return res.status(400).json({ status: "error", message: "Insufficient Balance!" });
        }

        const receiverSnap = await get(ref(db, "users/" + targetNumber));
        if (!receiverSnap.exists()) {
            return res.status(404).json({ status: "error", message: "Receiver not registered!" });
        }
        let receiverData = receiverSnap.val() || {};

        const exactDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const txnId = "TXN" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

        const updates = {};
        updates[`users/${adminPhone}/balance`] = increment(-withdrawAmount);
        updates[`users/${targetNumber}/balance`] = increment(withdrawAmount);

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

        await update(ref(db), updates);

        if (adminData.tgUserId) {
            await sendTelegramMsg(adminData.tgUserId, `🚀 Swift Pay: API Payment Sent!\nTo: ${receiverData.name || targetNumber}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }
        if (receiverData.tgUserId) {
            await sendTelegramMsg(receiverData.tgUserId, `💰 Swift Pay: Payment Received!\nFrom: ${adminData.name || adminPhone}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }

        return res.status(200).json({ 
            status: "success", 
            message: `Payment successful to ${targetNumber}`,
            data: { transaction_id: txnId, amount: withdrawAmount, receiver: targetNumber, sender: adminPhone }
        });

    } catch (error) { 
        return res.status(500).json({ status: "error", message: "Server Error: " + error.message }); 
    }
}
