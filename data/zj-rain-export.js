/**
 * 浙江省水雨情数据导出脚本
 *
 * 使用方法：
 *   1. 浏览器打开 https://sqfb.slt.zj.gov.cn/weIndex.html#/main/map/water-rain
 *   2. 等页面加载完成
 *   3. F12 → Console → 粘贴运行本脚本
 *   4. 自动下载 JSON 文件
 *
 * 导出的数据：
 *   - 水雨情简况/简报文本
 *   - 雨量概况（各站雨量数据）
 *   - 水库报表
 *   - 水情信息（江河/河道水位）
 *   - 雨情等值面图片
 *   - 页面当前加载的全部原始数据
 */

(async function exportRainData() {
  try {
    // ===== 1. 从 Vuex Store 提取数据 =====
    const appEl = document.querySelector('#app');
    if (!appEl || !appEl.__vue_app__) {
      throw new Error('未检测到 Vue 应用，请确认已打开水雨情页面');
    }

    const app = appEl.__vue_app__;
    const store = app.config.globalProperties.$store;
    const state = store.state;

    const result = {
      exportTime: new Date().toISOString(),
      source: 'https://sqfb.slt.zj.gov.cn/weIndex.html#/main/map/water-rain',
      
      // 水雨情简况
      waterRainBrief: state.waterAndRain?.rainInfo || null,
      
      // 雨情等值面图
      rainContourMap: state.waterAndRain?.rainImg || null,
      
      // 告警/统计结果（雨量概况、水库、河道、闸坝、潮汐）
      alarmResult: state.alarmResult || null,
      
      // 雨量站明细表格数据
      rainDetail: state.waterAndRain?.allTableData || null,
      
      // 全局雨情/水情
      globalRainWater: state.rainAndwater || null,
    };

    // ===== 2. 从页面 DOM 提取表格数据 =====
    const tables = document.querySelectorAll('.el-table__body-wrapper table');
    const tableData = {};
    tables.forEach((table, idx) => {
      const rows = table.querySelectorAll('tr');
      const headers = [];
      table.querySelectorAll('th').forEach(th => headers.push(th.textContent.trim()));
      
      const data = [];
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length) {
          const item = {};
          cells.forEach((cell, i) => {
            if (headers[i]) item[headers[i]] = cell.textContent.trim();
          });
          data.push(item);
        }
      });
      if (data.length) tableData[`table_${idx}`] = { headers, rows: data };
    });
    result.pageTables = tableData;

    // ===== 3. 提取页面文本内容 =====
    const textBlocks = {};
    document.querySelectorAll('.overview p, .el-tab-pane p, .result p').forEach((el, idx) => {
      const text = el.textContent.trim();
      if (text) textBlocks[`text_${idx}`] = text;
    });
    result.pageTexts = textBlocks;

    // ===== 4. 输出并下载 =====
    const json = JSON.stringify(result, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zj-rain-data-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    console.log('✅ 导出成功！');
    console.log(`📦 文件名: ${a.download}`);
    console.log(`📊 数据大小: ${(json.length / 1024).toFixed(1)} KB`);
    console.log('\n📋 导出内容概览:');
    Object.entries(result).forEach(([key, val]) => {
      if (val && typeof val === 'object') {
        console.log(`   ${key}: ${JSON.stringify(val).length > 100 ? '✅' : JSON.stringify(val).slice(0, 80)}`);
      }
    });

    return result;
  } catch (e) {
    console.error('❌ 导出失败:', e.message);
    console.error('请确认已打开 https://sqfb.slt.zj.gov.cn/weIndex.html#/main/map/water-rain 页面');
  }
})();
