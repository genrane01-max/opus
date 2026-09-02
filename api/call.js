// api/call.js — ระบบเชื่อมสายคอลหลังบ้าน (เวอร์ชันออโต้ล็อกอิน ไม่ต้องใช้ Database Secret)
const DB_URL = process.env.FIREBASE_DATABASE_URL;
const API_KEY = process.env.FIREBASE_API_KEY; // 🔑 ดึงจาก env Vercel
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // 🔑 ดึงจาก env Vercel

// 🚀 ฟังก์ชันดึง "กุญแจผ่านทางชั่วคราว" (ID Token) ด้วยระบบล็อกอินอัตโนมัติ
async function getAdminToken() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@yourdomain.com',
      password: ADMIN_PASSWORD,
      returnSecureToken: true
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error("ขอสิทธิ์ผ่านทางแอดมินหลังบ้านล้มเหลว: " + (data.error?.message || "เชื่อมต่อไม่ได้"));
  }
  return data.idToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'อนุญาตเฉพาะการยิงแบบ POST เท่านั้นครับ' });
  }

  try {
    const { callerId, receiverId, action } = req.body;

    if (!callerId || !receiverId || !action) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    }

    // 🚀 1. ดึงกุญแจผ่านทางชั่วคราวชิ้นใหม่
    const tempToken = await getAdminToken();
    const creditUrl = `${DB_URL}/pendingCallCredits/${receiverId}/${callerId}.json?auth=${tempToken}`;

    if (action === 'accept') {
      const creditRes = await fetch(creditUrl);
      const credit = await creditRes.json();

      if (!credit) {
        return res.status(400).json({ error: 'ไม่พบคำร้องขอโทรนี้ หรือคู่สายหมดอายุแล้วครับ' });
      }

      const duration = parseInt(credit.duration) || 10;
      const commission = parseFloat(credit.commission) || 0;
      const expiresAt = Date.now() + (duration * 60 * 1000);

      // โอนค่าคอมมิชชั่นให้น้องผู้รับสาย
      if (commission > 0) {
        const balanceUrl = `${DB_URL}/onlineUsers/${receiverId}/balance.json?auth=${tempToken}`;
        const balRes = await fetch(balanceUrl);
        let currentBalance = await balRes.json() || 0;

        const newBalance = currentBalance + commission;
        await fetch(balanceUrl, {
          method: 'PUT',
          body: JSON.stringify(newBalance)
        });

        // บันทึกประวัติรายรับสะสมของน้อง
        const historyKey = `income_${Date.now()}`;
        await fetch(`${DB_URL}/userIncomeHistory/${receiverId}/${historyKey}.json?auth=${tempToken}`, {
          method: 'PUT',
          body: JSON.stringify({
            amount: commission,
            fromUser: callerId,
            type: "video_call_commission",
            timestamp: Date.now()
          })
        });
      }

      // ปรับสถานะเป็นติดสายกันสายซ้อน
      await fetch(`${DB_URL}/onlineUsers/${receiverId}/isBusy.json?auth=${tempToken}`, {
        method: 'PUT',
        body: JSON.stringify(true)
      });

      // สร้างคู่สายสนทนา
      const callKey = `${callerId}_${receiverId}`;
      await fetch(`${DB_URL}/authorizedCalls/${callKey}.json?auth=${tempToken}`, {
        method: 'PUT',
        body: JSON.stringify({
          callerId,
          receiverId,
          expiresAt,
          timestamp: Date.now()
        })
      });

      // ลบคำขอที่ประมวลผลเสร็จแล้ว
      await fetch(creditUrl, {
        method: 'DELETE'
      });

      return res.status(200).json({
        success: true,
        status: 'accepted',
        expiresAt
      });

    } else if (action === 'decline') {
      await fetch(creditUrl, {
        method: 'PUT',
        body: JSON.stringify({ status: 'declined' })
      });

      return res.status(200).json({
        success: true,
        status: 'declined'
      });

    } else {
      return res.status(400).json({ error: 'Action ไม่ถูกต้อง' });
    }

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'ระบบเชื่อมสายหลังบ้านขัดข้อง: ' + error.message });
  }
}