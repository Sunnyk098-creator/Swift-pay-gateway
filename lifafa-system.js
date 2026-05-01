// lifafa-system.js (ISOLATED LIFAFA FIREBASE SYSTEM)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, arrayUnion, collection, query, where, getDocs, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCvzeg8_7ym5QYcDcfKbtC09JM0GkCVDn8",
  authDomain: "swiftpay-459cb.firebaseapp.com",
  databaseURL: "https://swiftpay-459cb-default-rtdb.firebaseio.com",
  projectId: "swiftpay-459cb",
  storageBucket: "swiftpay-459cb.firebasestorage.app",
  messagingSenderId: "486646933498",
  appId: "1:486646933498:web:26d30dd5d36ddf9415e643"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function generateId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function getDeviceIpFingerprint() {
    let fp = localStorage.getItem('lif_fp');
    if(!fp) { fp = 'DEV_' + Math.random().toString(36).substr(2, 9); localStorage.setItem('lif_fp', fp); }
    return fp;
}

window.LifafaSystem = {
    async create(creatorPhone, data) {
        const lifafaId = generateId();
        const lifafaRef = doc(db, "lifafas", lifafaId);

        const payload = {
            creator: creatorPhone,
            type: data.type, // Standard, Scratch, Toss
            amount: data.amount || 0,
            maxAmount: data.maxAmount || 0,
            totalUsers: Number(data.totalUsers),
            claimedUsers: [], // Store phone numbers
            claimedDevices: [], // Anti-fraud
            claimedCount: 0,
            telegram: data.telegram,
            code: data.code || "",
            timestamp: Date.now(),
            status: "ACTIVE"
        };

        await setDoc(lifafaRef, payload);
        return lifafaId;
    },

    async getInfo(lifafaId) {
        const docSnap = await getDoc(doc(db, "lifafas", lifafaId));
        if (!docSnap.exists()) throw new Error("Lifafa not found!");
        let data = docSnap.data();
        
        // 72 Hours Expiry Auto-Check
        const hoursOld = (Date.now() - data.timestamp) / (1000 * 60 * 60);
        if (hoursOld > 72 && data.status === "ACTIVE") {
            data.status = "EXPIRED";
            await updateDoc(doc(db, "lifafas", lifafaId), { status: "EXPIRED" });
        }
        return { id: docSnap.id, ...data };
    },

    async claim(lifafaId, userPhone, enteredCode) {
        const lifafaRef = doc(db, "lifafas", lifafaId);
        const deviceId = getDeviceIpFingerprint();
        let finalReward = 0;
        let type = "";

        await runTransaction(db, async (transaction) => {
            const docSnap = await transaction.get(lifafaRef);
            if (!docSnap.exists()) throw new Error("Lifafa not found.");
            const data = docSnap.data();
            type = data.type;

            const hoursOld = (Date.now() - data.timestamp) / (1000 * 60 * 60);
            if (hoursOld > 72 || data.status === "EXPIRED") throw new Error("EXPIRED: This Lifafa has expired.");
            if (data.status !== "ACTIVE") throw new Error(`Lifafa is ${data.status}`);
            if (data.claimedCount >= data.totalUsers) throw new Error("Lifafa is fully claimed by others.");
            if (data.claimedUsers.includes(userPhone)) throw new Error("You have already claimed this Lifafa!");
            if (data.claimedDevices.includes(deviceId)) throw new Error("Anti-Fraud: Device already used!");
            if (data.code && data.code.trim() !== "" && data.code !== enteredCode) throw new Error("Invalid Unique Code.");

            // Calculate Reward
            if (data.type === 'Standard') {
                finalReward = data.amount;
            } else if (data.type === 'Scratch') {
                finalReward = Math.floor(Math.random() * data.maxAmount) + 1;
            } else if (data.type === 'Toss') {
                finalReward = (Math.random() < 0.5) ? data.amount : 0;
            }

            transaction.update(lifafaRef, {
                claimedUsers: arrayUnion(userPhone),
                claimedDevices: arrayUnion(deviceId),
                claimedCount: data.claimedCount + 1,
                status: (data.claimedCount + 1) >= data.totalUsers ? "COMPLETED" : "ACTIVE"
            });
        });

        return { reward: finalReward, type: type };
    },

    async getMyLifafas(creatorPhone) {
        const q = query(collection(db, "lifafas"), where("creator", "==", creatorPhone));
        const snapshot = await getDocs(q);
        let list = [];
        snapshot.forEach(doc => {
            let data = doc.data();
            const hoursOld = (Date.now() - data.timestamp) / (1000 * 60 * 60);
            if (hoursOld > 72 && data.status === "ACTIVE") data.status = "EXPIRED";
            list.push({ id: doc.id, ...data });
        });
        // Sort by newest first
        return list.sort((a,b) => b.timestamp - a.timestamp);
    }
};
