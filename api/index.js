import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCvzeg8_7ym5QYcDcfKbtC09JM0GkCVDn8",
  authDomain: "swiftpay-459cb.firebaseapp.com",
  databaseURL: "https://swiftpay-459cb-default-rtdb.firebaseio.com",
  projectId: "swiftpay-459cb",
  storageBucket: "swiftpay-459cb.firebasestorage.app",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const BOT_TOKEN = "8440520277:AAG-DcrzOHZ2jFtvMofUdgxK2ATPFvdwkwM";

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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { key, paytm, amount, comment, number } = req.query;
        
        const safeKey = String(key || "").trim();
        const targetNumber = String(paytm || number || "").trim(); 

        if (!safeKey) {
            return res.status(400).json({ status: "error", message: "Missing API Key!" });
        }

        // Direct O(1) Fetch to completely bypass Firebase Array Memory Crashes
        let adminPhone = null;
        const keySnap = await get(ref(db, `api_keys/${safeKey}`));
        
        if (keySnap.exists()) {
            adminPhone = keySnap.val();
        } else {
            // Self-healing fallback if old user hasn't synced yet
            const usersSnap = await get(ref(db, "users"));
            if (usersSnap.exists()) {
                const allUsers = usersSnap.val();
                for (const phone in allUsers) {
                    if (allUsers[phone] && allUsers[phone].apiKey && String(allUsers[phone].apiKey).trim() === safeKey) {
                        adminPhone = phone;
                        await update(ref(db), { [`api_keys/${safeKey}`]: phone }); // Heal it
                        break;
                    }
                }
            }
        }

        if (!adminPhone) {
            return res.status(401).json({ status: "error", message: "Invalid API Key! Old key is expired or incorrect." });
        }

        const adminSnap = await get(ref(db, `users/${adminPhone}`));
        if(!adminSnap.exists()) {
            return res.status(401).json({ status: "error", message: "API Owner account not found." });
        }
        const adminData = adminSnap.val();

        if (!targetNumber || !amount) {
            return res.status(400).json({ status: "error", message: "Missing target number or amount required." });
        }

        const withdrawAmount = Math.abs(Number(amount));
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            return res.status(400).json({ status: "error", message: "Invalid amount!" });
        }

        if (String(adminPhone) === targetNumber) {
            return res.status(400).json({ status: "error", message: "API Owner cannot send payment to their own number (Self-transfer not allowed)!" });
        }

        const currentAdminBal = Number(adminData.balance) || 0;
        if (currentAdminBal < withdrawAmount) {
            return res.status(400).json({ status: "error", message: "Insufficient Balance in API Owner's wallet!" });
        }

        const receiverSnap = await get(ref(db, "users/" + targetNumber));
        if (!receiverSnap.exists()) {
            return res.status(404).json({ status: "error", message: "Receiver mobile number is not registered in wallet!" });
        }
        let receiverData = receiverSnap.val() || {};
        const currentReceiverBal = Number(receiverData.balance) || 0;

        const exactDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const txnId = "TXN" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

        const updates = {};
        
        // Exact Mathematical override to bypass string-increment bugs in firebase
        updates[`users/${adminPhone}/balance`] = currentAdminBal - withdrawAmount;
        updates[`users/${targetNumber}/balance`] = currentReceiverBal + withdrawAmount;

        updates[`transactions/${txnId}`] = { 
            id: txnId, 
            type: "out", 
            title: "API Payment", 
            amount: withdrawAmount, 
            status: "Success", 
            date: exactDate, 
            timestamp: Date.now(), 
            icon: "fa-code", 
            color: "blue", 
            name: receiverData.name || targetNumber, 
            number: targetNumber,
            senderName: adminData.name || adminPhone,
            senderId: adminPhone, 
            receiverId: targetNumber,
            isApi: true
        };

        await update(ref(db), updates);

        let rName = receiverData.name || targetNumber;
        let aName = adminData.name || adminPhone;
        
        if (adminData.tgUserId) {
            sendTelegramMsg(adminData.tgUserId, `🤖 API Payment Sent!\nTo: ${rName}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
        }
        if (receiverData.tgUserId) {
            sendTelegramMsg(receiverData.tgUserId, `💰 API Payment Received!\nFrom: ${aName}\nAmount: ₹${withdrawAmount}\nTxn ID: ${txnId}`);
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
