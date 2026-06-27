/**
 * chart.js — Canvas 2D 图表工具（微信小程序）
 * 无外部依赖，使用原生 Canvas 2D API
 *
 * 提供三种图表：
 *   drawPieChart(canvasId, items, total, options)  — 环形饼图
 *   drawBarChart(canvasId, dailyData, options)     — 每日消费柱状图
 *   drawBudgetGauge(canvasId, spent, budget, options) — 半圆预算仪表
 *
 * 每个函数返回 Promise<string>，resolve 为临时图片路径
 */

const THEME = {
  colors: ['#5b9ff5', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#6b7280'],
  bg: '#ffffff',
  text: '#6b7280',
  textDark: '#1f2937',
  gridLine: '#f3f4f6',
  centerDot: '#e5e7eb'
};

/**
 * 获取 Canvas 2D 节点和上下文
 */
function getCanvas2D(canvasId, width, height) {
  return new Promise((resolve, reject) => {
    const query = wx.createSelectorQuery();
    query.select('#' + canvasId)
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('Canvas node not found: ' + canvasId));
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);
        resolve({ canvas, ctx, width, height, dpr });
      });
  });
}

/**
 * 导出 Canvas 为临时图片路径
 */
function canvasToTempPath(canvas) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => resolve(res.tempFilePath),
      fail: reject
    });
  });
}

/**
 * 环形饼图 — 消费类别分布
 *
 * @param {string} canvasId — canvas 元素 id
 * @param {Array} items — [{ key, label, amount, percent }] 按金额降序
 * @param {number} total — 总金额
 * @param {object} options — { width: 300, height: 300, innerRadius: 0.55 }
 * @returns {Promise<string>} tempFilePath
 */
async function drawPieChart(canvasId, items, total, options = {}) {
  const width = options.width || 300;
  const height = options.height || 300;
  const innerRadius = options.innerRadius || 0.55;

  if (!items || items.length === 0) return '';

  const { canvas, ctx } = await getCanvas2D(canvasId, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const outerR = Math.min(cx, cy) - 10;
  const innerR = outerR * innerRadius;

  // 清空
  ctx.clearRect(0, 0, width, height);

  // 阴影
  ctx.shadowColor = 'rgba(0,0,0,0.06)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;

  // 绘制扇形
  let startAngle = -Math.PI / 2;
  items.forEach((item, i) => {
    const sweep = (item.percent / 100) * Math.PI * 2;
    if (sweep <= 0) return;

    ctx.beginPath();
    ctx.moveTo(cx + innerR * Math.cos(startAngle), cy + innerR * Math.sin(startAngle));
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sweep);
    ctx.arc(cx, cy, innerR, startAngle + sweep, startAngle, true);
    ctx.closePath();

    ctx.fillStyle = THEME.colors[i % THEME.colors.length];
    ctx.fill();
    startAngle += sweep;
  });

  // 关闭阴影
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 中心文字
  ctx.fillStyle = THEME.textDark;
  ctx.font = 'bold 20px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('¥' + (total || 0), cx, cy - 8);

  ctx.fillStyle = THEME.text;
  ctx.font = '12px -apple-system, sans-serif';
  ctx.fillText('总消费', cx, cy + 16);

  return canvasToTempPath(canvas);
}

/**
 * 柱状图 — 每日消费趋势
 *
 * @param {string} canvasId
 * @param {Array} dailyData — [{ date: '06/20', amount: 350 }]
 * @param {object} options — { width: 340, height: 200, barColor, barWidth: 24, maxBars: 10 }
 * @returns {Promise<string>}
 */
async function drawBarChart(canvasId, dailyData, options = {}) {
  const width = options.width || 340;
  const height = options.height || 200;
  const barColor = options.barColor || '#5b9ff5';
  const barWidth = options.barWidth || 24;
  const maxBars = options.maxBars || 10;

  if (!dailyData || dailyData.length === 0) return '';

  const { canvas, ctx } = await getCanvas2D(canvasId, width, height);

  ctx.clearRect(0, 0, width, height);

  // 取最近 N 天
  const data = dailyData.slice(-maxBars);
  const maxAmount = Math.max(...data.map(d => d.amount), 1);

  // 计算绘图区域
  const padLeft = 44;
  const padRight = 16;
  const padTop = 20;
  const padBottom = 32;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const gap = Math.max(6, (chartW - data.length * barWidth) / (data.length + 1));

  // Y 轴网格线 + 标签
  ctx.fillStyle = THEME.text;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padTop + (chartH / ySteps) * i;
    const val = Math.round(maxAmount * (1 - i / ySteps));

    // 网格线
    ctx.strokeStyle = THEME.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();

    // Y 轴标签
    ctx.fillText('¥' + val, padLeft - 8, y);
  }

  // 柱子
  data.forEach((d, i) => {
    const barH = (d.amount / maxAmount) * chartH;
    const x = padLeft + gap + i * (barWidth + gap);
    const y = padTop + chartH - barH;

    // 渐变
    const gradient = ctx.createLinearGradient(x, y, x, padTop + chartH);
    gradient.addColorStop(0, barColor);
    gradient.addColorStop(1, barColor + '33');

    // 圆角顶部
    const r = Math.min(6, barWidth / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.arcTo(x + barWidth, y, x + barWidth, y + r, r);
    ctx.lineTo(x + barWidth, padTop + chartH);
    ctx.lineTo(x, padTop + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // X 轴标签
    ctx.fillStyle = THEME.text;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(d.date || '', x + barWidth / 2, padTop + chartH + 8);
  });

  return canvasToTempPath(canvas);
}

/**
 * 半圆预算仪表盘
 *
 * @param {string} canvasId
 * @param {number} spent — 已消费
 * @param {number} budget — 总预算
 * @param {object} options — { width: 200, height: 140 }
 * @returns {Promise<string>}
 */
async function drawBudgetGauge(canvasId, spent, budget, options = {}) {
  const width = options.width || 200;
  const height = options.height || 140;

  if (!budget || budget <= 0) return '';

  const { canvas, ctx } = await getCanvas2D(canvasId, width, height);

  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height - 10;
  const outerR = Math.min(cx, cy) - 4;
  const innerR = outerR * 0.65;
  const percent = Math.min(spent / budget, 1);

  // 背景弧
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, Math.PI, 0);
  ctx.arc(cx, cy, innerR, 0, Math.PI, true);
  ctx.closePath();
  ctx.fillStyle = THEME.gridLine;
  ctx.fill();

  // 进度弧
  const sweep = Math.PI * percent;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, Math.PI, Math.PI + sweep);

  // 圆角端点
  const endX = cx + outerR * Math.cos(Math.PI + sweep);
  const endY = cy + outerR * Math.sin(Math.PI + sweep);
  ctx.arc(endX, endY, 4, 0, Math.PI * 2);

  ctx.arc(cx, cy, innerR, Math.PI + sweep, Math.PI, true);
  ctx.closePath();

  const gaugeColor = percent > 1 ? '#ef4444' : percent > 0.8 ? '#f59e0b' : '#5b9ff5';
  ctx.fillStyle = gaugeColor;
  ctx.fill();

  // 中心文字
  ctx.fillStyle = THEME.textDark;
  ctx.font = 'bold 16px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(percent * 100) + '%', cx, cy - 18);

  ctx.fillStyle = THEME.text;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText('¥' + spent + ' / ¥' + budget, cx, cy + 6);

  return canvasToTempPath(canvas);
}

module.exports = {
  drawPieChart,
  drawBarChart,
  drawBudgetGauge
};
