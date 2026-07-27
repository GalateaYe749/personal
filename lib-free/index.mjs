/**
 * 浙江大学图书馆空闲座位自动监控+预约
 *
 * 功能：
 * 1. 自动登录浙大统一身份认证
 * 2. 每 0.5 秒查询一次指定区域的座位
 * 3. 发现空闲座位 → 自动预约第一个
 * 4. 结果通过钉钉通知
 * 5. 22:30 自动退出
 *
 * 用法：
 *   npm install
 *   cp .env.example .env   # 编辑 .env 填入你的信息
 *   node index.mjs
 *
 * 需修改区域：下面的 AREAS 数组（见 README.md）
 */

import "dotenv/config";
import { ZJUAM, BOOKINGLIB } from "login-zju";
import crypto from "node:crypto";

// ============================================================
// ⚙️ 配置区 - 在这里修改你要监控的区域
// ============================================================

// 你可以在下面添加/删除区域。格式：{ id, name, seats }
// 紫金港主馆区域对照：
//   二层南 = 58 (32座)    二层北 = 59 (176座)
//   三层东 = 60 (48座)    三层南 = 61 (112座)
//   三层北 = 62           四层东 = 63
//   四层南 = 64           四层西 = 65
//   四层北 = 66           五层东 = 67
const AREAS = [
  { id: "58", name: "二层南", seats: 32 },
  { id: "59", name: "二层北", seats: 176 },
];

const POLL_INTERVAL_MS = 500;        // 轮询间隔（毫秒）
const AUTO_EXIT_HOUR   = 22;         // 自动退出小时
const AUTO_EXIT_MINUTE = 30;         // 自动退出分钟

// ============================================================
// 下面是代码逻辑，一般不需要改
// ============================================================

// AES 加密参数（来自图书馆预约系统前端）
const AES_IV = Buffer.from([
  90, 90, 87, 66, 75, 74, 95, 90,
  72, 73, 72, 85, 65, 87, 69, 73,
]); // "ZZWBKJ_ZHIHUAWEI"

function getEncryptKey() {
  const d = new Date();
  const s =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  return s + s.split("").reverse().join("");
}

function aesEncrypt(data) {
  const key = Buffer.from(getEncryptKey(), "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, AES_IV);
  let enc = cipher.update(JSON.stringify(data), "utf8", "base64");
  enc += cipher.final("base64");
  return enc;
}

// 钉钉签名 + 发送
function dingtalkSign(timestamp) {
  const secret = process.env.DINGTALK_SECRET;
  const signStr = `${timestamp}\n${secret}`;
  return crypto
    .createHmac("sha256", secret)
    .update(signStr)
    .digest("base64");
}

async function sendDingtalk(message) {
  const webhook = process.env.DINGTALK_WEBHOOK;
  const secret = process.env.DINGTALK_SECRET;
  if (!webhook || !secret) {
    console.log("[钉钉] 未配置，跳过通知");
    return;
  }
  const timestamp = Date.now();
  const url = `${webhook}&timestamp=${timestamp}&sign=${dingtalkSign(timestamp)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: `📚 图书馆座位提醒\n${message}` },
      }),
    });
    const result = await res.json();
    if (result.errcode === 0) console.log("[钉钉] ✅ 已通知");
    else console.error("[钉钉] 发送失败:", result);
  } catch (e) {
    console.error("[钉钉] 异常:", e.message);
  }
}

// 获取今日可用时段（包含预约用的 segment）
async function getTodaySegment(client, areaId) {
  const res = await client.fetch(
    "https://booking.lib.zju.edu.cn/api/Seat/date",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ build_id: areaId }),
    }
  );
  const data = await res.json();
  if (data?.code !== 1 || !data?.data?.[0]?.times?.length) {
    throw new Error("获取时段失败: " + JSON.stringify(data));
  }
  const times = data.data[0].times;
  const available = times.find((t) => t.status === 1);
  if (!available) return null;
  return {
    segment: String(available.id),
    day: data.data[0].day,
    start: available.start,
    end: available.end,
  };
}

// 查询空闲座位
async function getFreeSeats(client, areaId, time) {
  const res = await client.fetch(
    "https://booking.lib.zju.edu.cn/api/Seat/seat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        area: areaId,
        segment: time.segment,
        day: time.day,
        startTime: time.start,
        endTime: time.end,
      }),
    }
  );
  const data = await res.json();
  const seats = data?.data || data || [];
  if (!Array.isArray(seats)) return [];
  return seats.filter((s) => String(s.status) === "1");
}

// 预约座位
async function bookSeat(client, seatId, segment) {
  let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (url, opts = {}) {
    const auth = opts?.headers?.Authorization || opts?.headers?.authorization;
    if (auth && typeof auth === "string" && auth.startsWith("bearer")) {
      captured = auth;
    }
    return origFetch.call(this, url, opts);
  };

  try {
    await client.fetch("https://booking.lib.zju.edu.cn/api/Seat/seat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        area: "58",
        segment,
        day: new Date().toISOString().slice(0, 10),
      }),
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  if (!captured) throw new Error("无法获取 bearer token");

  const encrypted = aesEncrypt({ seat_id: seatId, segment });

  const res = await fetch(
    "https://booking.lib.zju.edu.cn/api/Seat/confirm",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: captured,
      },
      body: JSON.stringify({
        aesjson: encrypted,
        authorization: captured,
      }),
    }
  );
  return res.json();
}

function shouldExit() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return h > AUTO_EXIT_HOUR || (h === AUTO_EXIT_HOUR && m >= AUTO_EXIT_MINUTE);
}

// ============================================================
// 🚀 主流程
// ============================================================

async function main() {
  console.log("=".repeat(50));
  console.log("📚 浙江大学图书馆 空闲座位监控+自动预约");
  console.log(
    `📅 ${new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
    })}`
  );
  console.log(`⏱ 轮询间隔: ${POLL_INTERVAL_MS / 1000} 秒`);
  console.log(
    `🕐 自动退出: ${String(AUTO_EXIT_HOUR).padStart(2, "0")}:${String(
      AUTO_EXIT_MINUTE
    ).padStart(2, "0")}`
  );
  console.log(
    `🏛 监控区域: ${AREAS.map((a) => a.name).join(", ")}`
  );
  console.log("=".repeat(50));

  // 登录 ZJUAM（浙大统一身份认证）
  console.log("[登录] 浙大统一身份认证...");
  const am = new ZJUAM(
    process.env.ZJU_USERNAME,
    process.env.ZJU_PASSWORD
  );
  let loggedIn = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await am.login();
      console.log(`[登录] ✅ 成功 (尝试 ${attempt})`);
      loggedIn = true;
      break;
    } catch (e) {
      console.log(`[登录] ❌ 第 ${attempt} 次失败: ${e.message}`);
    }
  }
  if (!loggedIn) {
    console.error("[登录] ❌ 重试 5 次均失败，请检查账号密码");
    process.exit(1);
  }

  // 连接图书馆预约系统
  console.log("[登录] 连接图书馆预约系统...");
  const bookingLib = new BOOKINGLIB(am);
  await bookingLib.login();
  console.log("[登录] ✅ 已登录");

  // 获取今日时段 ID（segment）
  console.log("[配置] 获取今日可用时段...");
  let timeInfo;
  try {
    timeInfo = await getTodaySegment(bookingLib, AREAS[0].id);
    if (!timeInfo) {
      console.error("[配置] ❌ 今日无可预约时段");
      process.exit(1);
    }
    console.log(
      `[配置] ✅ segment=${timeInfo.segment} (${timeInfo.start}-${timeInfo.end})`
    );
  } catch (e) {
    console.error("[配置] ❌ 获取失败:", e.message);
    process.exit(1);
  }

  // 轮询
  let booked = false;
  let loopCount = 0;

  console.log("[监控] 开始轮询...");
  while (!booked) {
    if (shouldExit()) {
      console.log(`[退出] 已到 ${AUTO_EXIT_HOUR}:${AUTO_EXIT_MINUTE}，自动退出`);
      break;
    }

    loopCount++;

    for (const area of AREAS) {
      try {
        const freeSeats = await getFreeSeats(bookingLib, area.id, timeInfo);
        if (freeSeats.length === 0) continue;

        const chosen = freeSeats[0];
        console.log(
          `\n[${area.name}] 🔥 发现空位! ${chosen.no} (共 ${freeSeats.length} 个空座)`
        );

        // 预约
        console.log(`[预约] 正在预约 ${chosen.no}...`);
        const result = await bookSeat(bookingLib, chosen.id, timeInfo.segment);

        if (result?.code === 1 || result?.msg === "预约成功") {
          console.log(`[预约] ✅ 成功！${result.area || area.name} ${result.no || chosen.no}`);
          console.log(`[预约] ⏰ ${result.time || `${timeInfo.start}-${timeInfo.end}`}`);
          await sendDingtalk(
            `🎉 座位自动预约成功！\n` +
              `📍 ${result.area || area.name}\n` +
              `🪑 ${result.no || chosen.no}\n` +
              `⏰ ${result.time || `${timeInfo.start}-${timeInfo.end}`}`
          );
          booked = true;
          break;
        } else {
          console.log(`[预约] ❌ 失败: ${result?.msg || "未知错误"}`);
          // 可能是被抢了，继续监控
        }
      } catch (e) {
        console.error(`[${area.name}] ❌ 错误: ${e.message}`);
      }
    }

    if (!booked) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  if (booked) {
    console.log("\n✅ 预约成功，监控结束！");
  } else {
    console.log("\n🛑 未找到空位，已自动退出");
  }
}

main().catch((e) => {
  console.error("[致命错误]", e);
  process.exit(1);
});
