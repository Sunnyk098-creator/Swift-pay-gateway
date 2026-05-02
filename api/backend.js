import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set, update, increment, runTransaction } from "firebase/database";

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
const db = getDatabase(app);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Only POST allowed" });

    const { action, data } = req.body;

    try {
        if (action === 'CHECK_USER') {
            const snap = await get(ref(db, `users/${data.phone}`));
            return res.json({ data: snap.exists() ? snap.val() : null });
        }

        if (action === 'LOGIN') {
            const snap = await get(ref(db, `users/${data.phone}`));
            if (!snap.exists() || snap.val().password !== data.password) throw new Error("Invalid Phone or Password!");
            if (snap.val().isBanned) throw new Error("Account is Banned.");
            return res.json({ data: snap.val() });
        }

        if (action === 'REGISTER') {
            const snap = await get(ref(db, `users/${data.phone}`));
            if (snap.exists()) throw new Error("Phone number already registered!");
            
            if(!data.userObj.apiKey) {
                data.userObj.apiKey = 'SP-' + Math.random().toString(36).substring(2, 10).toUpperCase();
            }
            
            await set(ref(db, `users/${data.phone}`), data.userObj);
            return res.json({ data: "Success" });
        }

        if (action === 'UPDATE_CREDS') {
            await update(ref(db, `users/${data.phone}`), { password: data.password, pin: data.pin });
            return res.json({ data: "Success" });
        }

        if (action === 'SYNC') {
            const safeRoundId = data.gameRoundId || 'NONE';
            
            const [uSnap, cSnap, tSnap, gSnap, pSnap] = await Promise.all([ 
                get(ref(db, `users/${data.phone}`)), 
                get(ref(db, "settings")), 
                get(ref(db, "transactions")), 
                get(ref(db, `game_rounds/${safeRoundId}`)),
                get(ref(db, "posts"))
            ]);
            let txns = [];
            if(tSnap.exists()) {
                tSnap.forEach(c => {
                    let t = c.val();
                    if(t.senderId === data.phone || t.receiverId === data.phone) {
                        let adaptedTxn = { ...t };
                        let rName = (t.name && t.name !== 'N/A') ? t.name : t.receiverId;
                        let sName = (t.senderName && t.senderName !== 'N/A') ? t.senderName : t.senderId;
                        if (t.senderId === data.phone && t.receiverId === data.phone) { adaptedTxn.type = t.type; } 
                        else if (t.senderId === data.phone) { 
                            adaptedTxn.type = 'out'; 
                            adaptedTxn.title = t.isApi ? `Sent via API to ${rName}` : `Sent to ${rName}`; 
                        } 
                        else if (t.receiverId === data.phone) { 
                            adaptedTxn.type = 'in'; 
                            if (t.senderId === 'SYSTEM' || t.senderId === data.phone || t.title.includes('Lifafa') || t.title.includes('Deposit via') || t.title.includes('Game') || t.title.includes('Gift') || t.title.includes('Maintenance Fee')) {
                                adaptedTxn.title = t.title;
                            } else {
                                adaptedTxn.title = t.isApi ? `API Payment Received from ${sName}` : `Received from ${sName}`; 
                            }
                            adaptedTxn.icon = t.icon || 'fa-arrow-down'; 
                            adaptedTxn.color = t.color || 'green'; 
                        }
                        txns.push(adaptedTxn);
                    }
                });
            }
            txns.sort((a, b) => b.timestamp - a.timestamp);

            let postsArr = [];
            if (pSnap.exists()) {
                pSnap.forEach(p => { postsArr.push(p.val()); });
            }

            get(ref(db, 'game_rounds')).then(allGamesSnap => {
                if (allGamesSnap.exists()) {
                    let rounds = [];
                    allGamesSnap.forEach(child => { rounds.push(child.key); });
                    if (rounds.length > 5) {
                        rounds.sort(); 
                        let updates = {};
                        for(let i = 0; i < 3; i++) {
                            if (rounds[i]) updates[`game_rounds/${rounds[i]}`] = null;
                        }
                        update(ref(db), updates).catch(()=>{});
                    }
                }
            }).catch(()=>{});

            // Sending serverTime for global timer synchronization
            return res.json({ data: { 
                serverTime: Date.now(), 
                user: uSnap.val() || {}, 
                settings: cSnap.val() || {}, 
                txns: txns, 
                gameRound: gSnap.val() || { totalRed: 0, totalGreen: 0 }, 
                posts: postsArr 
            }});
        }

        if (action === 'EXECUTE_TXN') {
            let execAmt = data.amount !== undefined ? Number(data.amount) : (data.txn && data.txn.amount !== undefined ? Number(data.txn.amount) : 0);
            
            if (execAmt <= 0 && data.mode !== 'GAME_REFUND') {
                throw new Error("Amount must be greater than zero!");
            }

            if (['SEND', 'WITHDRAW', 'DEPOSIT_FEE', 'KEEPER_LOCK'].includes(data.mode)) {
                const uSnap = await get(ref(db, `users/${data.sender}`));
                if (!uSnap.exists() || (Number(uSnap.val().balance) || 0) < execAmt) {
                    throw new Error("Insufficient Balance!");
                }
            }
            if (data.mode === 'KEEPER_WITHDRAW') {
                const uSnap = await get(ref(db, `users/${data.sender}`));
                if (!uSnap.exists() || (Number(uSnap.val().keeperBalance) || 0) < execAmt) {
                    throw new Error("Insufficient Keeper Balance!");
                }
            }

            const updates = {};
            if (data.mode === 'SEND') { updates[`users/${data.sender}/balance`] = increment(-execAmt); updates[`users/${data.receiver}/balance`] = increment(execAmt); } 
            else if (data.mode === 'WITHDRAW') { updates[`users/${data.sender}/balance`] = increment(-execAmt); } 
            else if (data.mode === 'DEPOSIT_FEE') { 
                updates[`users/${data.sender}/balance`] = increment(-execAmt); 
                if (data.txn) {
                    data.txn.title = "Server Maintenance Fee";
                    data.txn.type = "out";
                    data.txn.color = "red";
                    data.txn.icon = "fa-server";
                }
            } 
            else if (data.mode === 'KEEPER_LOCK') { updates[`users/${data.sender}/balance`] = increment(-execAmt); updates[`users/${data.sender}/keeperBalance`] = increment(execAmt); } 
            else if (data.mode === 'KEEPER_WITHDRAW') { updates[`users/${data.sender}/keeperBalance`] = increment(-execAmt); updates[`users/${data.sender}/balance`] = increment(execAmt); } 
            else if (data.mode === 'GAME_WIN' || data.mode === 'GAME_REFUND') { updates[`users/${data.sender}/balance`] = increment(execAmt); }
            
            if(data.txn) updates[`transactions/${data.txn.id}`] = data.txn;
            await update(ref(db), updates); return res.json({ data: "Success" });
        }

        if (action === 'BULK_PAY') {
            if (data.amount === undefined || Number(data.amount) <= 0) throw new Error("Amount must be greater than zero!");
            
            const total = Number(data.amount) * data.receivers.length;
            if (total <= 0) throw new Error("Invalid total amount!");
            
            const snap = await get(ref(db, `users/${data.sender}`));
            if (!snap.exists() || (Number(snap.val().balance) || 0) < total) {
                throw new Error("Insufficient Balance!");
            }

            const updates = { [`users/${data.sender}/balance`]: increment(-total) };
            data.receivers.forEach(num => {
                updates[`users/${num}/balance`] = increment(Number(data.amount));
                let txnId = 'TXN' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
                updates[`transactions/${txnId}`] = { id: txnId, type: 'out', title: 'Bulk Send', amount: Number(data.amount), status: 'Success', date: data.date, timestamp: Date.now(), icon: 'fa-paper-plane', color: 'blue', name: 'User', number: num, senderId: data.sender, receiverId: num };
            });
            await update(ref(db), updates); return res.json({ data: "Success" });
        }

        if (action === 'CREATE_LIFAFA') {
            let totalDeduct = 0;
            if (data.type === 'Scratch') {
                totalDeduct = Number(data.maxAmount) * Number(data.totalUsers);
            } else {
                totalDeduct = Number(data.amount) * Number(data.totalUsers);
            }
            if (totalDeduct <= 0) throw new Error("Invalid Lifafa Configuration!");

            const uSnap = await get(ref(db, `users/${data.phone}`));
            if (!uSnap.exists() || (Number(uSnap.val().balance) || 0) < totalDeduct) throw new Error("Insufficient Balance!");
            
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let lifafaId = '';
            for(let i=0; i<10; i++) lifafaId += chars.charAt(Math.floor(Math.random() * chars.length));

            const newLifafa = { 
                id: lifafaId, 
                creator: data.phone, 
                type: data.type || 'Standard', 
                amount: Number(data.amount) || 0, 
                minAmount: Number(data.minAmount) || 1,
                maxAmount: Number(data.maxAmount) || 0,
                totalUsers: Number(data.totalUsers), 
                claimedUsers: 0, 
                timestamp: Date.now(), 
                status: 'ACTIVE', 
                channel: (data.channel && data.channel.trim() !== "") ? data.channel.trim() : "",
                code: (data.code && data.code.trim() !== "") ? data.code.trim() : "" 
            };

            const updates = { 
                [`users/${data.phone}/balance`]: increment(-totalDeduct), 
                [`lifafas/${lifafaId}`]: newLifafa, 
                [`transactions/${data.txn.id}`]: data.txn 
            };
            await update(ref(db), updates); 
            return res.json({ data: lifafaId });
        }

        if (action === 'GET_LIFAFA_INFO') {
            const snap = await get(ref(db, `lifafas/${data.code}`));
            if (!snap.exists() || snap.val().status !== 'ACTIVE') throw new Error("Lifafa not found or fully claimed.");
            let lData = snap.val();
            return res.json({ data: { type: lData.type, channel: lData.channel, hasCode: (lData.code && lData.code.trim() !== "") } });
        }

        if (action === 'CLAIM_LIFAFA') {
            const lifafaRef = ref(db, `lifafas/${data.code}`);
            const lifafaSnap = await get(lifafaRef);
            if (!lifafaSnap.exists()) throw new Error("Lifafa not found.");
            
            let lData = lifafaSnap.val();
            if (lData.status !== 'ACTIVE') throw new Error("Lifafa is fully claimed or expired.");
            
            if (lData.code && lData.code.trim() !== "" && lData.code !== data.passCode) {
                throw new Error("Invalid Unique Code / Password!");
            }

            let wonAmount = 0;
            await update(ref(db), { dummy: null }); 
            
            const result = await runTransaction(lifafaRef, (currentData) => {
                if (currentData === null) return null; 
                if (currentData.status !== 'ACTIVE') return;
                if (currentData.claimers && currentData.claimers[data.phone]) return; 
                if (currentData.claimedUsers >= currentData.totalUsers) return; 

                currentData.claimedUsers = (currentData.claimedUsers || 0) + 1;
                if (!currentData.claimers) currentData.claimers = {};
                currentData.claimers[data.phone] = true;
                if (currentData.claimedUsers >= currentData.totalUsers) currentData.status = 'COMPLETED';
                return currentData;
            });

            if (!result.committed) throw new Error("Lifafa invalid, expired, or already claimed.");
            
            let resultData = result.snapshot.val();
            
            if (resultData.type === 'Scratch') {
                let min = Number(resultData.minAmount) || 1;
                let max = Number(resultData.maxAmount) || Number(resultData.amount) || 1;
                wonAmount = Math.floor(Math.random() * (max - min + 1)) + min;
            } else if (resultData.type === 'Toss') {
                wonAmount = Math.random() < 0.5 ? Number(resultData.amount) : 0;
            } else {
                wonAmount = Number(resultData.amount);
            }

            const updates = {};
            updates[`users/${data.phone}/balance`] = increment(wonAmount);
            
            if (wonAmount > 0) {
                updates[`transactions/${data.txn.id}`] = { ...data.txn, amount: wonAmount };
            }
            await update(ref(db), updates); 
            return res.json({ data: wonAmount });
        }

        if (action === 'CREATE_GIFT') {
            if (data.amount === undefined || Number(data.amount) <= 0) throw new Error("Amount must be greater than zero!");

            const total = Number(data.amount) * data.users;
            if (total <= 0) throw new Error("Invalid total amount!");

            const snap = await get(ref(db, `users/${data.phone}`));
            if (!snap.exists() || (Number(snap.val().balance) || 0) < total) {
                throw new Error("Insufficient Balance!");
            }

            const updates = { [`users/${data.phone}/balance`]: increment(-total), [`giftcodes/${data.code}`]: { amountPerUser: Number(data.amount), remainingUsers: data.users, totalUsers: data.users, createdBy: data.phone }, [`transactions/${data.txn.id}`]: data.txn };
            await update(ref(db), updates); return res.json({ data: "Success" });
        }

        if (action === 'CLAIM_GIFT') {
            let resultAmount = 0; const codeRef = ref(db, `giftcodes/${data.code}`); await update(ref(db), { dummy: null }); 
            const result = await runTransaction(codeRef, (currentData) => {
                if (currentData === null) return null; if (currentData.claimers && currentData.claimers[data.phone]) return; if (currentData.remainingUsers <= 0) return; 
                currentData.remainingUsers -= 1; if (!currentData.claimers) currentData.claimers = {}; currentData.claimers[data.phone] = true; return currentData;
            });
            if (!result.committed) throw new Error("Code invalid, expired, or already claimed.");
            
            resultAmount = Number(result.snapshot.val().amountPerUser);
            const updates = { 
                [`users/${data.phone}/balance`]: increment(resultAmount), 
                [`transactions/${data.txn.id}`]: { ...data.txn, amount: resultAmount } 
            };
            if (result.snapshot.val().remainingUsers <= 0) updates[`giftcodes/${data.code}`] = null; 
            await update(ref(db), updates); return res.json({ data: resultAmount });
        }

        if (action === 'GENERATE_API') {
            await update(ref(db, `users/${data.phone}`), { apiKey: data.newKey }); return res.json({ data: "Success" });
        }

        if (action === 'GAME_BET') {
            if (data.amount === undefined || Number(data.amount) <= 0) throw new Error("Amount must be greater than zero!");

            const uSnap = await get(ref(db, `users/${data.phone}`));
            if (!uSnap.exists() || (Number(uSnap.val().balance) || 0) < Number(data.amount)) {
                throw new Error("Insufficient Balance! Server sync failed.");
            }

            const updates = { [`users/${data.phone}/balance`]: increment(-Number(data.amount)) };
            if(data.color === 'red') updates[`game_rounds/${data.roundId}/totalRed`] = increment(Number(data.amount)); 
            else updates[`game_rounds/${data.roundId}/totalGreen`] = increment(Number(data.amount));
            
            if(data.txn) updates[`transactions/${data.txn.id}`] = data.txn;
            await update(ref(db), updates); return res.json({ data: "Success" });
        }

        if (action === 'RESET_ALL_BALANCES') {
            const usersSnap = await get(ref(db, "users"));
            const updates = {};
            if (usersSnap.exists()) {
                usersSnap.forEach(child => {
                    updates[`users/${child.key}/balance`] = 0;
                    updates[`users/${child.key}/keeperBalance`] = 0;
                });
                await update(ref(db), updates);
            }
            return res.json({ data: "Success" });
        }

        return res.status(400).json({ error: "Unknown Action" });
    } catch (e) { return res.status(500).json({ error: e.message }); }
}
