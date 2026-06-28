/**
 * export.js — 账单图片导出工具
 * 使用 Canvas 2D 渲染完整账单卡片，导出为临时图片
 */

const chart = require('./chart');

/**
 * 获取隐藏 Canvas 节点（模板中需预置 <canvas type="2d" id="exportCanvas">）
 */
function getExportCanvas(width, height) {
  return new Promise((resolve, reject) => {
    const query = wx.createSelectorQuery();
    query.select('#exportCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('Export canvas not found'));
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);
        resolve({ canvas, ctx, width, height });
      });
  });
}

function canvasToTempPath(canvas) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    });
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 绘制账单摘要卡片
 *
 * @param {string} canvasId — canvas 元素 id（默认 'exportCanvas'）
 * @param {object} trip — 行程信息 { name, startDate, endDate, city }
 * @param {Array} expenses — 消费列表
 * @param {object} summary — { total, shared, private }
 * @param {Array} categoryBreakdown — [{ key, label, amount, percent }]
 * @returns {Promise<string>} tempFilePath
 */
async function drawBillSummary(canvasId, trip, expenses, summary, categoryBreakdown) {
  const width = 375;
  const height = Math.min(1080, 650 + Math.min(expenses.length, 12) * 44);

  const { canvas, ctx } = await getExportCanvas(width, height);

  const pad = 22;
  let y = pad;

  // 清空
  ctx.clearRect(0, 0, width, height);

  // 背景
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#f3f8ff');
  bgGrad.addColorStop(0.55, '#f8fbff');
  bgGrad.addColorStop(1, '#f7f8fc');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // 头部渐变卡
  const headerH = 156;
  const headerGrad = ctx.createLinearGradient(pad, y, width - pad, y + headerH);
  headerGrad.addColorStop(0, '#7db9f8');
  headerGrad.addColorStop(0.56, '#5b9ff5');
  headerGrad.addColorStop(1, '#357de8');
  ctx.fillStyle = headerGrad;
  roundRect(ctx, pad, y, width - pad * 2, headerH, 24);
  ctx.fill();

  // 标题
  ctx.fillStyle = 'rgba(255,255,255,0.76)';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('拾途 ST · 旅行账本', pad + 20, y + 22);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px -apple-system, sans-serif';
  ctx.fillText((trip && trip.name) || '旅行账单', pad + 20, y + 44);

  // 副标题
  const dateStr = trip ? [(trip.startDate || ''), (trip.endDate || '')].filter(Boolean).join(' → ') : '';
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.fillText(dateStr + (trip && trip.city ? ' · ' + trip.city : ''), pad + 20, y + 76);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px -apple-system, sans-serif';
  ctx.fillText('¥' + (summary.total || 0), pad + 20, y + 104);
  y += headerH + 18;

  // 摘要数字卡
  const stats = [
    { label: '公共开销', value: '¥' + (summary.shared || 0) },
    { label: '私人开销', value: '¥' + (summary.private || 0) },
    { label: '账单笔数', value: String(expenses.length || 0) }
  ];
  const statGap = 8;
  const statW = (width - pad * 2 - statGap * 2) / 3;
  stats.forEach((s, i) => {
    const sx = pad + (statW + statGap) * i;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, sx, y, statW, 70, 16);
    ctx.fill();
    ctx.fillStyle = '#357de8';
    ctx.font = 'bold 15px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(s.value, sx + statW / 2, y + 15);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText(s.label, sx + statW / 2, y + 40);
  });
  y += 92;

  // 预算状态
  const budget = Number(trip && trip.totalBudget) || 0;
  if (budget > 0) {
    const spent = Number(summary.total) || 0;
    const percent = Math.min(100, Math.round(spent / budget * 100));
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, pad, y, width - pad * 2, 86, 20);
    ctx.fill();
    ctx.fillStyle = '#1e1e2e';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(spent > budget ? '预算已超支' : '预算进度', pad + 16, y + 15);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText(`预算 ¥${budget} · ${spent > budget ? `超出 ¥${(spent - budget).toFixed(2)}` : `剩余 ¥${(budget - spent).toFixed(2)}`}`, pad + 16, y + 38);
    ctx.fillStyle = '#ecf5ff';
    roundRect(ctx, pad + 16, y + 62, width - pad * 2 - 32, 8, 4);
    ctx.fill();
    const progressGrad = ctx.createLinearGradient(pad + 16, 0, width - pad - 16, 0);
    progressGrad.addColorStop(0, '#7db9f8');
    progressGrad.addColorStop(1, spent > budget ? '#ef4444' : '#357de8');
    ctx.fillStyle = progressGrad;
    roundRect(ctx, pad + 16, y + 62, Math.max(10, (width - pad * 2 - 32) * percent / 100), 8, 4);
    ctx.fill();
    y += 104;
  }

  // 分类占比条
  if (categoryBreakdown && categoryBreakdown.length > 0) {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, pad, y, width - pad * 2, 122, 20);
    ctx.fill();
    ctx.fillStyle = '#1e1e2e';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('钱主要花去哪了', pad + 16, y + 16);

    const barH = 12;
    const barW = width - pad * 2 - 32;
    const colors = ['#5b9ff5', '#7db9f8', '#65d6c5', '#8ea7ff', '#9cc7ff', '#b9c7d8'];
    let barX = pad + 16;
    categoryBreakdown.forEach((item, i) => {
      const segW = Math.max(4, barW * item.percent / 100);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(barX, y + 44, segW, barH);
      barX += segW;
    });

    // 图例
    let legendY = y + 72;
    let legendX = pad + 16;
    categoryBreakdown.slice(0, 5).forEach((item, i) => {
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(legendX, legendY, 10, 10);
      legendX += 14;
      ctx.fillStyle = '#4b5563';
      ctx.font = '11px -apple-system, sans-serif';
      const label = item.label + ' ' + item.percent + '%';
      const labelW = ctx.measureText(label).width + 24;
      if (legendX + labelW > width - pad) {
        legendX = pad + 16;
        legendY += 20;
      }
      ctx.fillText(label, legendX, legendY - 2);
      legendX += labelW;
    });
    y += 138;
  }

  // 消费列表
  ctx.fillStyle = '#1e1e2e';
  ctx.font = 'bold 14px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('最近账单', pad, y);
  y += 18;

  const colors = ['#5b9ff5', '#7db9f8', '#65d6c5', '#8ea7ff', '#9cc7ff', '#b9c7d8'];
  const maxItems = Math.min(expenses.length, 12);
  for (let i = 0; i < maxItems; i++) {
    const e = expenses[i];
    if (y > height - 80) break;

    ctx.fillStyle = '#ffffff';
    roundRect(ctx, pad, y, width - pad * 2, 50, 16);
    ctx.fill();

    // 类别色点
    const colorIdx = ['transport', 'hotel', 'food', 'tickets', 'shopping', 'other'].indexOf(e.category || 'other');
    ctx.fillStyle = colors[Math.max(0, colorIdx)];
    roundRect(ctx, pad + 12, y + 18, 10, 10, 5);
    ctx.fill();

    // 描述
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    const desc = (e.description || '消费').slice(0, 18);
    ctx.fillText(desc, pad + 30, y + 9);

    // 金额
    ctx.fillStyle = '#357de8';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('¥' + (e.netAmount || e.amount || 0), width - pad - 12, y + 9);

    // 付款人 + 类型
    ctx.fillStyle = '#9ca3af';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText((e.paidByName || '未知') + ' · ' + (e.type === 'shared' ? '公共' : '私人'), pad + 30, y + 29);

    y += 58;
  }

  if (expenses.length > maxItems) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('... 共 ' + expenses.length + ' 笔消费', width / 2, y);
    y += 24;
  }

  // 底部分隔线
  y = height - 50;
  ctx.strokeStyle = '#f3f4f6';
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(width - pad, y);
  ctx.stroke();

  // 品牌水印
  ctx.fillStyle = '#d1d5db';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('由 拾途 ST 生成', width / 2, y + 16);

  const dateStr2 = new Date().toISOString().slice(0, 10);
  ctx.fillText(dateStr2, width / 2, y + 32);

  return canvasToTempPath(canvas);
}

async function drawTripRecap(canvasId, trip, metrics, insights, timeline, recapText) {
  const width = 375;
  const rows = Math.min((timeline || []).length, 10);
  const height = Math.min(1200, 560 + rows * 58 + (recapText ? 120 : 0));
  const { canvas, ctx } = await getExportCanvas(width, height);
  const pad = 22;
  let y = pad;

  ctx.clearRect(0, 0, width, height);
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#f3f8ff');
  bgGrad.addColorStop(1, '#f8fbff');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  const headerH = 166;
  const headerGrad = ctx.createLinearGradient(pad, y, width - pad, y + headerH);
  headerGrad.addColorStop(0, '#8fc9ff');
  headerGrad.addColorStop(0.55, '#6eb2f7');
  headerGrad.addColorStop(1, '#5b9ff5');
  ctx.fillStyle = headerGrad;
  roundRect(ctx, pad, y, width - pad * 2, headerH, 26);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.76)';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('拾途 ST · 旅行手账', pad + 20, y + 22);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 23px -apple-system, sans-serif';
  ctx.fillText((trip && trip.name) || '旅行回忆', pad + 20, y + 48);

  ctx.fillStyle = 'rgba(255,255,255,0.84)';
  ctx.font = '12px -apple-system, sans-serif';
  const meta = [trip && trip.city, trip && trip.startDate, trip && trip.endDate].filter(Boolean).join(' · ');
  ctx.fillText(meta, pad + 20, y + 80);

  const statText = `${metrics.days || 0} 天 · ${metrics.members || 0} 位成员 · ${metrics.planItems || 0} 个安排`;
  ctx.fillText(statText, pad + 20, y + 104);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px -apple-system, sans-serif';
  ctx.fillText(`¥${metrics.total || '0.00'}`, pad + 20, y + 126);
  y += headerH + 18;

  const stats = [
    { label: '动态', value: String(metrics.moments || 0) },
    { label: '图片', value: String(metrics.images || 0) },
    { label: '公共账', value: '¥' + (metrics.shared || '0.00') }
  ];
  const statGap = 8;
  const statW = (width - pad * 2 - statGap * 2) / 3;
  stats.forEach((s, i) => {
    const sx = pad + (statW + statGap) * i;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, sx, y, statW, 70, 16);
    ctx.fill();
    ctx.fillStyle = '#357de8';
    ctx.font = 'bold 15px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(s.value, sx + statW / 2, y + 15);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText(s.label, sx + statW / 2, y + 40);
  });
  y += 92;

  if (recapText) {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, pad, y, width - pad * 2, 126, 20);
    ctx.fill();
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('AI 复盘', pad + 16, y + 16);
    ctx.fillStyle = '#536174';
    ctx.font = '12px -apple-system, sans-serif';
    const lines = String(recapText).replace(/\s+/g, ' ').slice(0, 110).match(/.{1,24}/g) || [];
    lines.slice(0, 3).forEach((line, index) => ctx.fillText(line, pad + 16, y + 42 + index * 20));
    y += 144;
  }

  if (insights && insights.length) {
    ctx.fillStyle = '#1e1e2e';
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('这趟的小结', pad, y);
    y += 20;
    insights.slice(0, 3).forEach(item => {
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, pad, y, width - pad * 2, 44, 14);
      ctx.fill();
      ctx.fillStyle = '#5b9ff5';
      roundRect(ctx, pad + 12, y + 16, 10, 10, 5);
      ctx.fill();
      ctx.fillStyle = '#536174';
      ctx.font = '12px -apple-system, sans-serif';
      ctx.fillText(String(item).slice(0, 28), pad + 30, y + 13);
      y += 52;
    });
  }

  ctx.fillStyle = '#1e1e2e';
  ctx.font = 'bold 14px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('旅行时间线', pad, y + 6);
  y += 28;
  (timeline || []).slice(0, 10).forEach(item => {
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, pad, y, width - pad * 2, 50, 16);
    ctx.fill();
    ctx.fillStyle = '#357de8';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillText(String(item.displayDate || '').slice(0, 8), pad + 14, y + 10);
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillText(String(item.title || '安排').slice(0, 20), pad + 82, y + 9);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(String(item.meta || '').slice(0, 28), pad + 82, y + 29);
    y += 58;
  });

  y = height - 48;
  ctx.fillStyle = '#d1d5db';
  ctx.font = '12px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('由 拾途 ST 生成', width / 2, y);
  ctx.fillText(new Date().toISOString().slice(0, 10), width / 2, y + 18);
  return canvasToTempPath(canvas);
}

module.exports = {
  drawBillSummary,
  drawTripRecap
};
