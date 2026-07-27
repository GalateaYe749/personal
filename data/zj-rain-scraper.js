/**
 * 浙江省水雨情监测平台 - 雨水数据爬虫
 *
 * 数据来源：https://sqfb.slt.zj.gov.cn/weIndex.html#/main/map/water-rain
 * 使用方式：
 *   1. 在浏览器中打开上述页面
 *   2. 打开开发者工具 (F12) → Console
 *   3. 复制下方 fetchRainData() 函数粘贴运行
 *   4. 或：在 Node.js 中运行此脚本（需带 Cookie 登录态）
 *
 * 数据说明：
 *   - 雨情信息：各监测站实时雨量（前1h/3h/24h 累计）
 *   - 水情信息：江河、水库水位
 *   - 数据来源于 ArcGIS Feature Server + REST API
 */

const CONFIG = {
  // REST API 基础路径
  API_BASE: "https://sqfb.slt.zj.gov.cn",
  // ArcGIS 地图服务（雨情/水情图层）
  ARCGIS_URL:
    "https://sqfb.zjsq.net.cn:8089/zjswmap/arcgis/rest/services/FBCW/MapServer",
};

/**
 * 从 REST API 获取雨水数据
 * @param {string} cookie - 浏览器登录后的 Cookie（从 F12 → Application → Cookies 复制）
 */
async function fetchRainData(cookie) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: cookie,
    Referer: "https://sqfb.slt.zj.gov.cn/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  const results = {};

  try {
    // 1. 获取水雨情简报
    console.log("[1/5] 获取水雨情简报...");
    const briefRes = await fetch(
      `${CONFIG.API_BASE}/rest/newList/getNewDataList`,
      { headers }
    );
    results.brief = await briefRes.json();
    console.log("  ✅ 水雨情简报获取完成");
  } catch (e) {
    console.warn("  ⚠️ 水雨情简报获取失败:", e.message);
  }

  try {
    // 2. 查询 ArcGIS 雨情图层（FBCW MapServer Layer 0）
    console.log("[2/5] 查询 ArcGIS 雨情图层...");
    const rainQueryUrl = `${
      CONFIG.ARCGIS_URL
    }/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&resultRecordCount=5000`;
    const rainRes = await fetch(rainQueryUrl, { headers });
    const rainData = await rainRes.json();
    results.rainStations = rainData;
    console.log(
      `  ✅ 雨情站点数据获取完成: ${
        rainData.features?.length || 0
      } 个站点`
    );
  } catch (e) {
    console.warn("  ⚠️ ArcGIS 雨情图层获取失败:", e.message);
  }

  try {
    // 3. 获取降雨量统计数据（前1h/3h/24h 超阈值统计）
    console.log("[3/5] 获取降雨量告警统计...");
    const alarmRes = await fetch(
      `${CONFIG.API_BASE}/rest/weatherForecast/transmitRainWg`,
      { headers }
    );
    results.rainAlarm = await alarmRes.json();
    console.log("  ✅ 降雨量告警统计获取完成");
  } catch (e) {
    console.warn("  ⚠️ 降雨量告警统计获取失败:", e.message);
  }

  try {
    // 4. 获取区域列表（用于关联站点所属区域）
    console.log("[4/5] 获取区域基础数据...");
    const areaRes = await fetch(
      `${CONFIG.API_BASE}/rest/basic/getAreaList?page=1&pageSize=200`,
      { headers }
    );
    results.areas = await areaRes.json();
    console.log("  ✅ 区域数据获取完成");
  } catch (e) {
    console.warn("  ⚠️ 区域数据获取失败:", e.message);
  }

  try {
    // 5. 获取台风/暴雨预报路径
    console.log("[5/5] 获取台风/暴雨预报...");
    const stormRes = await fetch(
      `${CONFIG.API_BASE}/rest/stormSurges/getTyphoonInfoAndPrePath`,
      { headers }
    );
    results.storm = await stormRes.json();
    console.log("  ✅ 台风/暴雨预报获取完成");
  } catch (e) {
    console.warn("  ⚠️ 台风/暴雨预报获取失败:", e.message);
  }

  return results;
}

/**
 * 在浏览器中直接运行的版本（自动使用当前页面的 Cookie）
 * 打开 https://sqfb.slt.zj.gov.cn/weIndex.html#/main/map/water-rain
 * 然后在 Console 中粘贴以下代码运行：
 */
const BROWSER_SCRIPT = `
(async () => {
  // ===== 从 Vuex Store 提取已加载的实时数据 =====
  const app = document.querySelector('#app').__vue_app__;
  const store = app.config.globalProperties.$store;
  
  const result = {
    // 雨情信息（雨量概况、超阈值站点列表）
    rainInfo: store.state.waterAndRain?.rainInfo,
    // 所有表格数据（雨量站明细、水库水位、河道水位）
    allTableData: store.state.waterAndRain?.allTableData,
    // 雨情等值面图片 URL
    rainImg: store.state.waterAndRain?.rainImg,
    // 全局雨情/水情汇总
    rainAndwater: store.state.rainAndwater,
  };

  console.log('📊 雨水数据提取完成', result);
  console.log('💾 复制下面这行保存到 JSON 文件:');
  console.log(JSON.stringify(result, null, 2));
  
  // 也可以下载为 JSON 文件
  const blob = new Blob([JSON.stringify(result, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = \`zj-rain-data-\${new Date().toISOString().slice(0,10)}.json\`;
  a.click();
})();
`;

// ============================================
// Node.js 使用方式
// ============================================
// 1. 先在浏览器登录 https://sqfb.slt.zj.gov.cn
// 2. F12 → Application → Cookies → 复制 JSESSIONID
// 3. 运行:
//    node zj-rain-scraper.js <你的JSESSIONID>
//
// 如果从浏览器 Console 运行，直接用 BROWSER_SCRIPT 即可

if (typeof window === "undefined") {
  // Node.js 环境
  const cookie = process.argv[2];
  if (!cookie) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  浙江省水雨情数据爬虫                                        ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  用法 1（推荐）：在浏览器 Console 中运行 BROWSER_SCRIPT        ║
║                                                              ║
║  用法 2（Node.js）：                                          ║
║    node zj-rain-scraper.js <JSESSIONID>                      ║
║                                                              ║
║  用法 3（浏览器 Console 简化版）：                              ║
║    ${BROWSER_SCRIPT.slice(0, 80)}...                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    process.exit(0);
  }

  const cookieStr = `JSESSIONID=${cookie}`;
  fetchRainData(cookieStr)
    .then((data) => {
      console.log("\n📊 全部数据获取完成!");
      console.log(JSON.stringify(data, null, 2));

      // 保存到文件
      const fs = require("fs");
      const filename = `zj-rain-data-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      fs.writeFileSync(filename, JSON.stringify(data, null, 2), "utf-8");
      console.log(`\n💾 已保存到: ${filename}`);
    })
    .catch(console.error);
}
