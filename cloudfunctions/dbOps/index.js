const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const resolveOpenid = require('./resolveOpenid');
const CLOUD_VERSION = '2026.06.27.4';

const EXPENSE_CATEGORY_LABELS = {
  transport: '交通', hotel: '住宿', food: '餐饮',
  tickets: '门票', shopping: '购物', other: '其他'
};

function inferExpenseCategory(text) {
  if (/打车|地铁|公交|高铁|火车|机票|油费|停车|交通/.test(text)) return 'transport';
  if (/酒店|民宿|宾馆|住宿|房费/.test(text)) return 'hotel';
  if (/餐|饭|吃|喝|咖啡|奶茶|烧烤|火锅|小吃/.test(text)) return 'food';
  if (/门票|票|景区|展览|演出/.test(text)) return 'tickets';
  if (/购物|买|纪念品|商场/.test(text)) return 'shopping';
  return 'other';
}

function addDaysToDate(dateString, offset) {
  const date = new Date(`${String(dateString || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(offset || 0));
  return date.toISOString().slice(0, 10);
}

function sanitizeReusablePlanItems(items, seed = '') {
  return (Array.isArray(items) ? items : []).slice(0, 30).map((item, index) => {
    const normalized = {
      title: String(item.title || '').trim().slice(0, 100),
      type: ['spot', 'food', 'hotel', 'transport', 'shopping', 'other'].includes(item.type) ? item.type : 'spot',
      time: String(item.time || '').slice(0, 5),
      location: String(item.location || '').slice(0, 100),
      locationAddress: String(item.locationAddress || '').slice(0, 160),
      notes: String(item.notes || '').slice(0, 300),
      sortId: `plan_${seed || Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 7)}`
    };
    if (Number.isFinite(Number(item.latitude))) normalized.latitude = Number(item.latitude);
    if (Number.isFinite(Number(item.longitude))) normalized.longitude = Number(item.longitude);
    return normalized;
  });
}

function requestJson(url, options = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ...options, timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          if (!body.trim()) {
            throw new Error(`天气接口返回空数据 (HTTP ${res.statusCode || '未知'})`);
          }
          let data;
          try {
            data = JSON.parse(body);
          } catch (_) {
            throw new Error(`天气接口返回格式错误 (HTTP ${res.statusCode || '未知'})`);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(data.message || data.error || `接口请求失败 (${res.statusCode})`);
          }
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('接口请求超时')));
    req.on('error', reject);
  });
}

function weatherCodeText(code) {
  const value = Number(code);
  if (value === 0) return '晴';
  if ([1, 2, 3].includes(value)) return '多云';
  if ([45, 48].includes(value)) return '雾';
  if (value >= 51 && value <= 57) return '小雨';
  if (value >= 61 && value <= 67) return '雨';
  if (value >= 71 && value <= 77) return '雪';
  if (value >= 80 && value <= 82) return '阵雨';
  if (value >= 85 && value <= 86) return '阵雪';
  if (value >= 95) return '雷雨';
  return '天气待定';
}

async function getOpenMeteoWeather(city) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const geoData = await requestJson(geoUrl);
  const location = geoData.results && geoData.results[0];
  if (!location) throw new Error('未找到该城市');
  const forecastUrl = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${encodeURIComponent(location.latitude)}` +
    `&longitude=${encodeURIComponent(location.longitude)}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&forecast_days=7';
  const forecast = await requestJson(forecastUrl);
  const daily = forecast.daily || {};
  if (!Array.isArray(daily.time)) throw new Error('天气数据获取失败');
  return daily.time.map((date, index) => ({
    date,
    dateShort: String(date).slice(5),
    tempHigh: Math.round(Number(daily.temperature_2m_max[index])),
    tempLow: Math.round(Number(daily.temperature_2m_min[index])),
    textDay: weatherCodeText(daily.weather_code[index])
  }));
}

function callZhipuText(apiKey, systemPrompt, userMessage, maxTokens = 900) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: process.env.ZHIPU_MODEL || 'glm-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.6,
      max_tokens: maxTokens,
      stream: true
    });
    const req = https.request('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      timeout: 45000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          let text = '';
          if (raw.includes('data:')) {
            raw.split(/\r?\n/).forEach(line => {
              if (!line.startsWith('data:')) return;
              const value = line.slice(5).trim();
              if (!value || value === '[DONE]') return;
              const chunk = JSON.parse(value);
              if (chunk.error) throw new Error(chunk.error.message || 'AI 调用失败');
              const choice = chunk.choices && chunk.choices[0];
              text += (choice && choice.delta && choice.delta.content) || '';
            });
          } else {
            const json = JSON.parse(raw || '{}');
            if (json.error) throw new Error(json.error.message || 'AI 调用失败');
            text = json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content || '' : '';
          }
          if (!text.trim()) throw new Error(`AI 未返回内容 (HTTP ${res.statusCode || '未知'})`);
          resolve(text.trim());
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 回复超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
// 非流式调用智谱，支持 function calling
function callZhipuWithTools(apiKey, messages, tools) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: process.env.ZHIPU_MODEL || 'glm-4',
      messages,
      tools,
      temperature: 0.6,
      max_tokens: 1600
    });
    const req = https.request('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      timeout: 50000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw || '{}');
          if (json.error) throw new Error(json.error.message || 'AI 调用失败');
          const msg = json.choices && json.choices[0] && json.choices[0].message;
          if (!msg) throw new Error('AI 返回为空');
          resolve({ content: msg.content || '', tool_calls: msg.tool_calls || null });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 回复超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const XIXI_WRITE_TOOLS = new Set(['create_trip', 'update_trip', 'add_expense', 'delete_trip', 'set_current_trip']);

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findXixiTrip(db, openid, tripName, activeOnly = false) {
  const { data: memberships } = await db.collection('trip_members').where({ openid }).get();
  if (!memberships.length) return { memberships: [], membership: null, trip: null };
  const tripIds = memberships.map(member => member.tripId);
  if (!tripName) {
    let user = null;
    const { data: openidUsers } = await db.collection('users').where({ openid }).limit(1).get();
    user = openidUsers[0] || null;
    if (!user) {
      const { data: uidUsers } = await db.collection('users').where({ uid: openid }).limit(1).get();
      user = uidUsers[0] || null;
    }
    if (user && user.currentTripId && tripIds.includes(user.currentTripId)) {
      const { data: currentTrip } = await db.collection('trips').doc(user.currentTripId).get();
      if (currentTrip && (!activeOnly || currentTrip.status === 'active')) {
        return {
          memberships,
          trip: currentTrip,
          membership: memberships.find(member => member.tripId === currentTrip._id) || null
        };
      }
    }
  }
  const condition = { _id: db.command.in(tripIds) };
  if (activeOnly) condition.status = 'active';
  if (tripName) {
    condition.name = db.RegExp({ regexp: escapeRegExp(tripName), options: 'i' });
  }
  const { data: trips } = await db.collection('trips').where(condition).limit(20).get();
  const sorted = (trips || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const trip = tripName
    ? sorted.find(item => item.name === tripName) || sorted[0] || null
    : (sorted.length === 1 ? sorted[0] : null);
  return {
    memberships,
    trip,
    membership: trip ? memberships.find(member => member.tripId === trip._id) || null : null
  };
}

function getXixiActionPreview(tool, args = {}) {
  switch (tool) {
    case 'create_trip':
      return {
        title: '创建行程',
        detail: `${args.name || '新行程'} · ${args.city || '目的地待定'} · ${Number(args.days) || 3} 天`
      };
    case 'update_trip': {
      const changes = [];
      if (args.newName) changes.push(`名称改为 ${args.newName}`);
      if (args.city) changes.push(`目的地改为 ${args.city}`);
      if (args.startDate) changes.push(`出发 ${args.startDate}`);
      if (args.days) changes.push(`${Number(args.days)} 天`);
      return { title: '修改行程', detail: `${args.tripName || '当前行程'}${changes.length ? ` · ${changes.join(' · ')}` : ''}` };
    }
    case 'add_expense':
      return {
        title: '添加共享账单',
        detail: `${args.description || '支出'} · ¥${Number(args.amount || 0).toFixed(2)}${args.tripName ? ` · ${args.tripName}` : ''}`
      };
    case 'delete_trip':
      return { title: '删除行程', detail: `将永久删除「${args.tripName || '未指定行程'}」及其成员、计划、账本和动态` };
    case 'set_current_trip':
      return { title: '切换当前行程', detail: `将「${args.tripName || '未指定行程'}」设为 AI 和记账默认使用的行程` };
    default:
      return { title: '执行操作', detail: tool };
  }
}

// 工具执行器 - 在云函数端执行操作
async function executeXixiTool(db, openid, toolName, args) {
  switch (toolName) {
    case 'create_trip': {
      const { name, city, days } = args;
      if (!name || !city) return { ok: false, msg: '缺少行程名称或目的地' };
      const d = new Date();
      const startDate = args.startDate || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const endDate = args.endDate || (() => { const e = new Date(startDate); e.setDate(e.getDate() + (days || 3) - 1); return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`; })();
      const totalDays = days || 3;
      const tripRef = await db.collection('trips').add({ data: { name, city, startDate, endDate, totalDays, totalBudget: 0, categoryBudgets: {}, status: 'active', createdAt: new Date().toISOString(), totalMembers: 1 } });
      const tripId = tripRef._id;
      await db.collection('trip_members').add({ data: { tripId, openid, role: 'owner', joinedAt: new Date().toISOString() } });
      try {
        const { data: users } = await db.collection('users').where({ openid }).limit(1).get();
        if (users[0] && !users[0].currentTripId) {
          await db.collection('users').doc(users[0]._id).update({ data: { currentTripId: tripId, updatedAt: new Date().toISOString() } });
        }
      } catch (_) {}
      return { ok: true, msg: `已创建「${name}」`, tripId, name, city, startDate, endDate, totalDays };
    }
    case 'set_current_trip': {
      const { tripName } = args;
      if (!tripName) return { ok: false, msg: '请告诉我要设为当前的行程' };
      const found = await findXixiTrip(db, openid, tripName);
      if (!found.trip) return { ok: false, msg: `找不到「${tripName}」` };
      if (found.trip.status === 'archived') return { ok: false, msg: '历史行程不能设为当前行程' };
      let user = null;
      const { data: openidUsers } = await db.collection('users').where({ openid }).limit(1).get();
      user = openidUsers[0] || null;
      if (!user) {
        const { data: uidUsers } = await db.collection('users').where({ uid: openid }).limit(1).get();
        user = uidUsers[0] || null;
      }
      if (!user) return { ok: false, msg: '用户资料不存在' };
      await db.collection('users').doc(user._id).update({ data: { currentTripId: found.trip._id, updatedAt: new Date().toISOString() } });
      return { ok: true, msg: `已将「${found.trip.name}」设为当前行程`, tripId: found.trip._id };
    }
    case 'update_trip': {
      const { tripName } = args;
      const found = await findXixiTrip(db, openid, tripName);
      if (!found.trip) return { ok: false, msg: tripName ? `找不到「${tripName}」` : '请先设置当前行程' };
      if (!found.membership || !['creator', 'owner'].includes(found.membership.role)) {
        return { ok: false, msg: '只有行程创建者才能修改基础信息' };
      }
      const update = {};
      if (args.newName) update.name = String(args.newName).trim().slice(0, 40);
      if (args.city) update.city = String(args.city).trim().slice(0, 40);
      if (args.startDate) update.startDate = String(args.startDate).slice(0, 10);
      const days = Number(args.days);
      if (Number.isFinite(days) && days >= 1 && days <= 60) update.totalDays = Math.round(days);
      const startDate = update.startDate || found.trip.startDate;
      const totalDays = update.totalDays || Number(found.trip.totalDays) || 1;
      if (startDate && (update.startDate || update.totalDays)) {
        const end = new Date(startDate);
        if (!Number.isNaN(end.getTime())) {
          end.setDate(end.getDate() + totalDays - 1);
          update.endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
        }
      }
      if (!Object.keys(update).length) return { ok: false, msg: '没有可修改的内容' };
      await db.collection('trips').doc(found.trip._id).update({ data: update });
      return { ok: true, msg: `已更新「${found.trip.name}」`, tripId: found.trip._id, changes: update };
    }
    case 'add_expense': {
      const { description, amount, category, tripName } = args;
      if (!description || !amount) return { ok: false, msg: '缺少描述或金额' };
      const found = await findXixiTrip(db, openid, tripName, !tripName);
      const trip = found.trip;
      if (!trip) return { ok: false, msg: tripName ? `找不到「${tripName}」` : '请先设置当前行程，再进行记账' };
      // 获取付款人昵称
      let paidByName = '我';
      try {
        const { data: users } = await db.collection('users').where({ openid }).limit(1).get();
        if (users.length) paidByName = users[0].nickName || '我';
      } catch (_) {}
      const categoryMap = { '交通': 'transport', '住宿': 'hotel', '餐饮': 'food', '门票': 'tickets', '购物': 'shopping', '其他': 'other' };
      const cat = EXPENSE_CATEGORY_LABELS[category] ? category : (categoryMap[category] || inferExpenseCategory(description));
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 10000000) return { ok: false, msg: '金额不正确' };
      await db.collection('expenses').add({ data: {
        tripId: trip._id,
        type: 'shared',
        category: cat,
        amount: amt,
        description: String(description).slice(0, 100),
        paidBy: openid,
        paidByName,
        splitAmong: found.memberships.filter(m => m.tripId === trip._id).map(m => m.openid),
        createdBy: openid,
        createdAt: new Date().toISOString()
      } });
      return { ok: true, msg: `已记账：${description} ¥${amt}（${trip.name}）` };
    }
    case 'get_my_trips': {
      const { data: memberships } = await db.collection('trip_members').where({ openid }).get();
      if (!memberships.length) return { ok: true, msg: '你还没有行程', trips: [] };
      const tripIds = memberships.map(m => m.tripId);
      const { data: trips } = await db.collection('trips').where({ _id: db.command.in(tripIds) }).orderBy('createdAt', 'desc').limit(10).get();
      if (!trips.length) return { ok: true, msg: '你还没有行程', trips: [] };
      const current = await findXixiTrip(db, openid, '', true);
      const currentTripId = current.trip ? current.trip._id : '';
      return {
        ok: true,
        msg: current.trip ? `你有 ${trips.length} 个行程，当前行程是「${current.trip.name}」` : `你有 ${trips.length} 个行程，尚未设置当前行程`,
        trips: trips.map(t => ({ id: t._id, name: t.name, city: t.city, status: t.status, startDate: t.startDate, endDate: t.endDate, isCurrent: t._id === currentTripId }))
      };
    }
    case 'delete_trip': {
      const { tripName } = args;
      if (!tripName) return { ok: false, msg: '请告诉我要删除哪个行程' };
      // 通过 trip_members 找到用户的行程
      const { data: memberships } = await db.collection('trip_members').where({ openid }).get();
      if (!memberships.length) return { ok: false, msg: '你还没有行程' };
      const tripIds = memberships.map(m => m.tripId);
      // 按名称模糊匹配
      const { data: trips } = await db.collection('trips').where({
        _id: db.command.in(tripIds),
        name: db.RegExp({ regexp: String(tripName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
      }).limit(5).get();
      if (!trips.length) return { ok: false, msg: `找不到「${tripName}」` };
      // 精确匹配优先
      const trip = trips.find(t => t.name === tripName) || trips[0];
      // 校验是否为创建者
      const membership = memberships.find(m => m.tripId === trip._id);
      if (!membership || (membership.role !== 'creator' && membership.role !== 'owner')) {
        return { ok: false, msg: '只有行程创建者才能删除' };
      }
      // 清理关联数据
      for (const col of ['trip_members', 'day_plans', 'expenses', 'moments']) {
        while (true) {
          const { data: docs } = await db.collection(col).where({ tripId: trip._id }).limit(100).get();
          if (!docs.length) break;
          await Promise.all(docs.map(doc => db.collection(col).doc(doc._id).remove()));
          if (docs.length < 100) break;
        }
      }
      await db.collection('trips').doc(trip._id).remove();
      try {
        let user = null;
        const { data: openidUsers } = await db.collection('users').where({ openid }).limit(1).get();
        user = openidUsers[0] || null;
        if (!user) {
          const { data: uidUsers } = await db.collection('users').where({ uid: openid }).limit(1).get();
          user = uidUsers[0] || null;
        }
        if (user && user.currentTripId === trip._id) {
          await db.collection('users').doc(user._id).update({ data: { currentTripId: '', updatedAt: new Date().toISOString() } });
        }
      } catch (_) {}
      return { ok: true, msg: `已删除行程「${trip.name}」` };
    }
    case 'get_weather': {
      const { city } = args;
      if (!city) return { ok: false, msg: '请告诉我要查哪个城市的天气' };
      const qweatherKey = process.env.QWEATHER_KEY || '';
      try {
        // 1. 城市查询
        const geoUrl = `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&key=${qweatherKey}`;
        const geoData = await requestJson(geoUrl);
        if (geoData.code !== '200' || !geoData.location || !geoData.location.length) {
          // 和风不可用，用备用源
          throw new Error('城市查询失败');
        }
        const locationId = geoData.location[0].id;
        // 2. 7天预报
        const weatherUrl = `https://devapi.qweather.com/v7/weather/7d?location=${encodeURIComponent(locationId)}&key=${qweatherKey}`;
        const weatherData = await requestJson(weatherUrl);
        if (weatherData.code !== '200' || !Array.isArray(weatherData.daily)) {
          throw new Error('天气查询失败');
        }
        const forecast = weatherData.daily.slice(0, 7).map(d =>
          `${d.fxDate.slice(5)} ${d.textDay} ${d.tempMin}~${d.tempMax}℃`
        ).join('；');
        return { ok: true, msg: `${city} 未来天气预报：${forecast}` };
      } catch (e) {
        // 备用：Open-Meteo
        try {
          const weather = await getOpenMeteoWeather(city);
          const forecast = weather.map(d =>
            `${d.dateShort} ${d.textDay} ${d.tempLow}~${d.tempHigh}℃`
          ).join('；');
          return { ok: true, msg: `${city} 未来天气预报：${forecast}` };
        } catch (e2) {
          return { ok: false, msg: `天气查询失败：${e2.message || e.message}` };
        }
      }
    }
    case 'get_trip_detail': {
      const { tripName } = args;
      if (!tripName) return { ok: false, msg: '请告诉我要查看哪个行程' };
      const { data: memberships } = await db.collection('trip_members').where({ openid }).get();
      if (!memberships.length) return { ok: false, msg: '你还没有行程' };
      const tripIds = memberships.map(m => m.tripId);
      const { data: trips } = await db.collection('trips').where({
        _id: db.command.in(tripIds),
        name: db.RegExp({ regexp: String(tripName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
      }).limit(5).get();
      if (!trips.length) return { ok: false, msg: `找不到「${tripName}」` };
      const trip = trips.find(t => t.name === tripName) || trips[0];
      // 获取成员和日程
      const [membersRes, plansRes] = await Promise.all([
        db.collection('trip_members').where({ tripId: trip._id }).get(),
        db.collection('day_plans').where({ tripId: trip._id }).orderBy('dayIndex', 'asc').get()
      ]);
      const memberCount = (membersRes.data || []).length;
      const plans = (plansRes.data || []).map(p => {
        const items = (p.items || []).map(it => `${it.time || ''} ${it.title || ''}`.trim()).join('、');
        return `第${p.dayIndex + 1}天${p.date ? '（' + p.date + '）' : ''}：${items || '暂无安排'}`;
      });
      let msg = `「${trip.name}」${trip.city ? ' · ' + trip.city : ''}\n${trip.totalDays || '?'}天 | ${trip.startDate || '?'} ~ ${trip.endDate || '?'} | ${memberCount}人`;
      if (trip.status !== 'active') msg += ` | ${trip.status === 'completed' ? '已结束' : '已取消'}`;
      if (plans.length) msg += '\n\n日程安排：\n' + plans.join('\n');
      return { ok: true, msg, trip: { id: trip._id, name: trip.name, city: trip.city, status: trip.status, startDate: trip.startDate, endDate: trip.endDate, totalDays: trip.totalDays, memberCount } };
    }
    default: return { ok: false, msg: `未知操作: ${toolName}` };
  }
}

// 拾途 AI 可调用的工具
const XIXI_TOOLS = [
  { type: 'function', function: { name: 'create_trip', description: '创建一个新的旅行行程。当用户说要创建/新建行程、去某地旅游时调用。', parameters: { type: 'object', properties: { name: { type: 'string', description: '行程名称，如"北京三日游"' }, city: { type: 'string', description: '目的地城市' }, days: { type: 'number', description: '天数，默认3' }, startDate: { type: 'string', description: '出发日期 YYYY-MM-DD，不填默认今天' } }, required: ['name', 'city'] } } },
  { type: 'function', function: { name: 'update_trip', description: '修改已有行程的名称、目的地、出发日期或天数。未指定行程名称时修改当前行程。', parameters: { type: 'object', properties: { tripName: { type: 'string', description: '行程名称；修改当前行程时可不填' }, newName: { type: 'string', description: '新名称' }, city: { type: 'string', description: '新目的地' }, startDate: { type: 'string', description: '新出发日期 YYYY-MM-DD' }, days: { type: 'number', description: '新天数' } } } } },
  { type: 'function', function: { name: 'set_current_trip', description: '将用户指定的行程设为当前行程。多个旅行计划并存时，AI、天气和未指定行程的记账默认使用当前行程。', parameters: { type: 'object', properties: { tripName: { type: 'string', description: '要设为当前的行程名称' } }, required: ['tripName'] } } },
  { type: 'function', function: { name: 'add_expense', description: '记录一笔共享消费/支出并由行程成员平摊。当用户说记账、花了多少钱、AA等时调用。', parameters: { type: 'object', properties: { description: { type: 'string', description: '消费内容' }, amount: { type: 'number', description: '金额（元）' }, category: { type: 'string', description: '分类：food/transport/hotel/tickets/shopping/other' }, tripName: { type: 'string', description: '所属行程名称，用户明确说出时填写' } }, required: ['description', 'amount'] } } },
  { type: 'function', function: { name: 'get_my_trips', description: '查看用户的行程列表。当用户问"我的行程"、"有哪些行程"时调用。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'delete_trip', description: '删除一个行程。当用户说删除/取消行程时调用。删除前应先告知用户将清除该行程的所有关联数据（成员、计划、记账、动态），需用户确认后再执行。', parameters: { type: 'object', properties: { tripName: { type: 'string', description: '要删除的行程名称' } }, required: ['tripName'] } } },
  { type: 'function', function: { name: 'get_weather', description: '查询城市未来7天天气预报。当用户问天气、气温、穿什么衣服时调用。', parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名称，如"北京"、"三亚"、"东京"' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'get_trip_detail', description: '查看某个行程的详细信息，包括日程安排、成员等。当用户问某次旅行的具体安排、行程内容时调用。', parameters: { type: 'object', properties: { tripName: { type: 'string', description: '行程名称' } }, required: ['tripName'] } } }
];

const XIXI_SYSTEM_PROMPT = `你是“拾途 AI”，一位审美很好、表达自然、真正懂生活协作与旅行的智能伙伴。你不是客服，也不要暴露机器人的口吻。

## 说话气质
- 像一个见过很多地方、愿意认真替朋友做功课的人：自然、松弛、具体，有判断但不端着
- 先回应用户真正关心的事，再补充理由；不要复述问题，不要用“当然可以”“很高兴为你服务”“根据您的需求”等客服套话
- 句子长短有变化，少用空泛形容词，多用具体动作、时间和取舍，让建议读起来有画面但不过度抒情
- 可以温柔，也可以直接；信息不足时只追问最关键的一件事
- 不使用 emoji
- 如果用户让你执行写操作，调用工具生成待确认操作卡；不要声称已经完成，提醒用户确认后才会执行

## 你的能力
- 创建和修改行程、记账、查行程、删行程、查天气、看行程详情
- 推荐目的地、规划行程、估算预算
- 美食推荐、景点攻略、出行提醒和打包建议

## 当前行程规则
- 用户有多个计划且没有明确说行程名称时，写操作只使用用户设置的当前行程
- 如果没有设置当前行程，不要猜测，提醒用户先指定“把某某设为当前行程”

## 回答规则
- 简单问题用 1—3 句话直接回答，不要强行列清单
- 复杂规划先给一句结论，再按 2—4 个小节展开；小节标题使用“## 标题”，条目使用“- 内容”
- 每段只讲一件事，段落之间留空行；避免连续十几行的大段文字
- 需要用户决策时，把最推荐的方案放在前面，并明确说明为什么
- 不要滥用标题、编号和总结，同一条回复保持一种清晰结构即可
- 涉及实时信息要提醒用户确认
- 不要编造具体价格、航班号、酒店名
- 使用自然、准确、好读的中文标点；不要输出表格或代码块`;

/**
 * 数据库操作云函数
 * 所有操作均在服务端校验用户身份
 * - upsertUser：只能修改自己的信息
 * - toggleFollow：只能以自己身份关注/取关
 */
exports.main = async (event, context) => {
  const { OPENID: wxOpenid } = cloud.getWXContext();
  if (!wxOpenid) {
    return { success: false, error: '未登录' };
  }

  const OPENID = await resolveOpenid(db, wxOpenid, event._sessionToken || '', {
    ensureCollection: ensureUsersCollection
  });

  const { action, payload } = event;

  function isCollectionAlreadyExists(e) {
    const msg = String(e.message || e.errMsg || '');
    return /-501001|already exists|collection exists/i.test(msg);
  }

  async function ensureUsersCollection() {
    try {
      await db.createCollection('users');
    } catch (e) {
      if (!isCollectionAlreadyExists(e)) throw e;
    }
  }

  async function ensurePackingCollection() {
    try {
      await db.createCollection('user_packing');
    } catch (e) {
      if (!isCollectionAlreadyExists(e)) throw e;
    }
  }

  async function ensurePackingHistoryCollection() {
    try {
      await db.createCollection('packing_histories');
    } catch (e) {
      if (!isCollectionAlreadyExists(e)) throw e;
    }
  }

  async function requireCurrentPackingTrip() {
    const found = await findXixiTrip(db, OPENID, '', true);
    if (!found.trip) throw new Error('请先在行程页设置当前行程');
    return found.trip;
  }

  async function getPackingItemsForTrip(trip, migrateLegacy = false) {
    const { data } = await db.collection('user_packing')
      .where({ openid: OPENID })
      .orderBy('createdAt', 'asc')
      .limit(500)
      .get();
    const allItems = data || [];
    const legacyItems = allItems.filter(item => !item.tripId);
    if (migrateLegacy && legacyItems.length) {
      await Promise.all(legacyItems.map(item => db.collection('user_packing').doc(item._id).update({
        data: { tripId: trip._id, migratedAt: new Date().toISOString() }
      })));
      legacyItems.forEach(item => { item.tripId = trip._id; });
    }
    return allItems.filter(item => item.tripId === trip._id);
  }

  function normalizePackingInput(items) {
    const allowedCategories = new Set(['clothing', 'toiletries', 'electronics', 'documents', 'medicine', 'other']);
    const seen = new Set();
    return (Array.isArray(items) ? items : []).map(item => ({
      name: String(item && item.name || '').trim().slice(0, 50),
      category: allowedCategories.has(item && item.category) ? item.category : 'other'
    })).filter(item => {
      if (!item.name) return false;
      const key = `${item.category}::${item.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 80);
  }

  async function requireTripCreator(tripId) {
    if (!tripId) throw new Error('缺少 tripId');
    try {
      const { data: members } = await db.collection('trip_members')
        .where({ tripId, openid: OPENID, role: db.command.in(['creator', 'owner']) })
        .get();
      if (members.length > 0) return true;
    } catch (e) {
      if (!isCollectionNotFound(e)) throw e;
    }

    try {
      const { data: trip } = await db.collection('trips').doc(tripId).get();
      if (trip && trip.creatorId === OPENID) return true;
    } catch (e) {
      // doc not found or collection not found
      throw new Error('行程不存在');
    }
    throw new Error('仅创建者可操作');
  }

  async function removeByTripId(collectionName, tripId) {
    while (true) {
      try {
        const { data } = await db.collection(collectionName).where({ tripId }).limit(100).get();
        if (!data.length) break;
        await Promise.all(data.map(doc => db.collection(collectionName).doc(doc._id).remove()));
        if (data.length < 100) break;
      } catch (e) {
        // 集合还不存在 = 没有数据需要删，直接跳过
        if (isCollectionNotFound(e)) break;
        throw e;
      }
    }
  }

  async function deleteTripWithAuth(tripId) {
    await requireTripCreator(tripId);
    await removeByTripId('trip_members', tripId);
    await removeByTripId('day_plans', tripId);
    await removeByTripId('expenses', tripId);
    await removeByTripId('moments', tripId);
    await db.collection('trips').doc(tripId).remove();
    const user = await getUserByIdentity(OPENID);
    if (user && user.currentTripId === tripId) {
      await db.collection('users').doc(user._id).update({
        data: { currentTripId: '', updatedAt: new Date().toISOString() }
      });
    }
  }

  async function updateByOpenid(collectionName, openidField, openid, updateData) {
    let updated = 0;
    const batchSize = 100;
    while (true) {
      const { data } = await db.collection(collectionName)
        .where({ [openidField]: openid })
        .skip(updated)
        .limit(batchSize)
        .get();
      if (!data.length) break;
      await Promise.all(data.map(doc =>
        db.collection(collectionName).doc(doc._id).update({ data: updateData })
      ));
      updated += data.length;
      if (data.length < batchSize) break;
    }
    return updated;
  }

  function privateConversationId(a, b) {
    if (!a || !b) throw new Error('缺少用户标识');
    return [a, b].sort().join('__');
  }

  function newPublicId() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function isSixDigitPublicId(value) {
    return /^\d{6}$/.test(String(value || ''));
  }

  async function createUniquePublicId() {
    await ensureCollection('users');
    for (let i = 0; i < 12; i++) {
      const candidate = newPublicId();
      const { data } = await db.collection('users').where({ publicId: candidate }).limit(1).get();
      if (!data.length) return candidate;
    }
    throw new Error('生成 ID 失败，请重试');
  }

  async function ensurePublicId(user) {
    if (!user) return null;
    if (isSixDigitPublicId(user.publicId)) {
      user.publicId = String(user.publicId);
      return user;
    }
    const publicId = await createUniquePublicId();
    await db.collection('users').doc(user._id).update({ data: { publicId } });
    user.publicId = publicId;
    return user;
  }

  async function getFriendRequestsBetween(a, b) {
    await ensureCollection('friend_requests');
    const [forward, reverse] = await Promise.all([
      db.collection('friend_requests').where({ from: a, to: b }).orderBy('createdAt', 'desc').limit(1).get(),
      db.collection('friend_requests').where({ from: b, to: a }).orderBy('createdAt', 'desc').limit(1).get()
    ]);
    return [...(forward.data || []), ...(reverse.data || [])]
      .sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  }

  async function getFriendState(targetOpenid) {
    if (!targetOpenid || targetOpenid === OPENID) return { status: 'self', requestId: '' };
    const requests = await getFriendRequestsBetween(OPENID, targetOpenid);
    const accepted = requests.find(item => item.status === 'accepted');
    if (accepted) return { status: 'friends', requestId: accepted._id };
    const pending = requests.find(item => item.status === 'pending');
    if (!pending) return { status: 'none', requestId: '' };
    return {
      status: pending.from === OPENID ? 'outgoing' : 'incoming',
      requestId: pending._id
    };
  }

  async function requireFriend(targetOpenid) {
    const state = await getFriendState(targetOpenid);
    if (state.status !== 'friends') throw new Error('成为好友后才能邀请同行');
    return state;
  }

  async function assertCanPrivateMessage(targetOpenid) {
    const [sender, target] = await Promise.all([
      getUserByIdentity(OPENID),
      getUserByIdentity(targetOpenid)
    ]);
    if (!target) throw new Error('用户不存在');
    const targetPrivacy = target.privacySettings || {};
    if (targetPrivacy.allowPrivateMessage === false) throw new Error('对方已关闭私信');
    const senderBlocked = (sender && sender.blockedOpenids) || [];
    const targetBlocked = target.blockedOpenids || [];
    if (senderBlocked.includes(targetOpenid)) throw new Error('你已屏蔽对方');
    if (targetBlocked.includes(OPENID)) throw new Error('暂时无法向对方发送消息');
    return { sender, target };
  }

  // 非好友且非互相关注情况下，只能发 3 条私信
  async function checkPrivateMessageLimit(targetOpenid) {
    // 1. 是好友 → 不限
    const friendState = await getFriendState(targetOpenid);
    if (friendState.status === 'friends') return;
    // 2. 互相关注 → 不限
    await ensureCollection('follows');
    const [iFollow, theyFollow] = await Promise.all([
      db.collection('follows').where({ follower: OPENID, following: targetOpenid }).count(),
      db.collection('follows').where({ follower: targetOpenid, following: OPENID }).count()
    ]);
    if (iFollow.total > 0 && theyFollow.total > 0) return;
    // 3. 都不是 → 最多 3 条
    const { total } = await db.collection('private_messages')
      .where({ from: OPENID, to: targetOpenid, type: db.command.neq('revoked') })
      .count();
    if (total >= 3) throw new Error('非好友或互相关注关系下，只能发送 3 条私信');
  }

  async function addPrivateMessage(targetOpenid, messageData) {
    if (!targetOpenid || targetOpenid === OPENID) throw new Error('缺少私信对象');
    await assertCanPrivateMessage(targetOpenid);
    await touchUserActive(OPENID);
    await ensureCollection('private_messages');
    const message = {
      conversationId: privateConversationId(OPENID, targetOpenid),
      from: OPENID,
      to: targetOpenid,
      createdAt: new Date().toISOString(),
      ...messageData
    };
    const res = await db.collection('private_messages').add({ data: message });
    return { ...message, _id: res._id };
  }

  async function getPrivateMessageWithAccess(messageId) {
    if (!messageId) throw new Error('缺少消息');
    const { data: message } = await db.collection('private_messages').doc(messageId).get();
    if (!message || (message.from !== OPENID && message.to !== OPENID)) {
      throw new Error('消息不存在');
    }
    return message;
  }

  async function buildPrivateQuote(quoteMessageId, targetOpenid) {
    if (!quoteMessageId) return {};
    const message = await getPrivateMessageWithAccess(quoteMessageId);
    const conversationId = privateConversationId(OPENID, targetOpenid);
    if (message.conversationId !== conversationId || message.type === 'revoked') {
      throw new Error('引用消息已失效');
    }
    const sender = await getUserByIdentity(message.from);
    return {
      quoteMessageId: message._id,
      quoteSenderId: message.from,
      quoteSenderName: (sender && sender.nickName) || '用户',
      quoteText: String(messagePreview(message) || '消息').slice(0, 100)
    };
  }

  async function requireGroupMember(groupId, openid = OPENID) {
    if (!groupId) throw new Error('缺少群聊');
    const { data } = await db.collection('group_members').where({ groupId, openid }).limit(1).get();
    if (!data.length) throw new Error('你已不在该群聊中');
    return data[0];
  }

  async function buildGroupQuote(quoteMessageId, groupId) {
    if (!quoteMessageId) return {};
    const { data: quoteMsg } = await db.collection('group_messages').doc(quoteMessageId).get();
    if (!quoteMsg || quoteMsg.groupId !== groupId || quoteMsg.type === 'revoked') {
      throw new Error('引用消息已失效');
    }
    const sender = await getUserByIdentity(quoteMsg.from);
    return {
      quoteMessageId: quoteMsg._id,
      quoteSenderId: quoteMsg.from,
      quoteSenderName: (sender && sender.nickName) || '群成员',
      quoteText: String(messagePreview(quoteMsg) || '消息').slice(0, 100)
    };
  }

  function messagePreview(message) {
    if (message.type === 'revoked') return '[消息已撤回]';
    if (message.type === 'trip_invite') return `[行程邀请] ${message.tripName || ''}`;
    if (message.type === 'image') return '[图片]';
    if (message.type === 'voice') return `[语音] ${message.voiceDuration || 1}秒`;
    if (message.type === 'location') return `[位置] ${message.locationName || ''}`;
    if (message.type === 'file') return `[文件] ${message.fileName || ''}`;
    if (message.type === 'user_card') return `[名片] ${message.cardName || ''}`;
    if (message.type === 'moment_share') return '[动态分享]';
    return message.text || '';
  }

  async function touchUserActive(openid) {
    if (!openid) return '';
    const lastActiveAt = new Date().toISOString();
    try {
      await ensureCollection('users');
      const user = await getUserByIdentity(openid);
      if (user) {
        await ensurePublicId(user);
        await db.collection('users').doc(user._id).update({ data: { uid: openid, openid, lastActiveAt } });
      } else {
        const publicId = await createUniquePublicId();
        await db.collection('users').add({
          data: { uid: openid, openid, publicId, nickName: '', avatarUrl: '', lastActiveAt, updatedAt: lastActiveAt }
        });
      }
    } catch (e) {
      console.warn('touchUserActive failed:', e.message);
    }
    return lastActiveAt;
  }

  async function getUserLastActiveAt(openid) {
    if (!openid) return '';
    try {
      const user = await getUserByIdentity(openid);
      return user ? (user.lastActiveAt || '') : '';
    } catch (e) {
      return '';
    }
  }

  async function getUserByIdentity(openid) {
    if (!openid) return null;
    const openidRes = await db.collection('users').where({ openid }).limit(1).get();
    if (openidRes.data && openidRes.data.length > 0) return openidRes.data[0];
    const uidRes = await db.collection('users').where({ uid: openid }).limit(1).get();
    return uidRes.data && uidRes.data.length > 0 ? uidRes.data[0] : null;
  }

  async function getUsersByOpenids(openids) {
    const ids = [...new Set((openids || []).filter(Boolean))];
    if (!ids.length) return {};
    let data = [];
    try {
      const [openidRes, uidRes] = await Promise.all([
        db.collection('users').where({ openid: _.in(ids) }).limit(100).get(),
        db.collection('users').where({ uid: _.in(ids) }).limit(100).get()
      ]);
      const byId = {};
      [...(openidRes.data || []), ...(uidRes.data || [])].forEach(user => {
        byId[user._id] = user;
      });
      data = Object.values(byId);
    } catch (e) {
      if (!isCollectionNotFound(e)) throw e;
    }
    const map = {};
    data.forEach(user => {
      map[user.openid || user.uid] = user;
    });
    return map;
  }

  function toSafeUser(user, isSelf = false) {
    if (!user) return null;
    const privacy = user.privacySettings || {};
    // 状态超过 24 小时自动过期
    let moodExpired = false;
    if (user.moodUpdatedAt) {
      const elapsed = Date.now() - new Date(user.moodUpdatedAt).getTime();
      if (elapsed > 24 * 60 * 60 * 1000) moodExpired = true;
    }
    const moodVisible = (isSelf || privacy.showMoodStatus !== false) && !moodExpired;
    const safe = {
      openid: user.openid || user.uid || '',
      uid: user.uid || user.openid || '',
      publicId: user.publicId || '',
      nickName: user.nickName || '',
      avatarUrl: user.avatarUrl || '',
      avatarThumbUrl: user.avatarThumbUrl || '',
      signature: user.signature || '',
      moodEmoji: moodVisible ? (user.moodEmoji || '') : '',
      moodText: moodVisible ? (user.moodText || '') : '',
      moodUpdatedAt: moodVisible ? (user.moodUpdatedAt || '') : '',
      wornBadge: user.wornBadge || '',
      showBadge: user.showBadge !== false,
      privacySettings: {
        allowProfileView: privacy.allowProfileView !== false,
        allowPrivateMessage: privacy.allowPrivateMessage !== false
      }
    };
    if (isSelf) {
      safe.username = user.username || '';
      safe.privacySettings.defaultMomentPrivate = privacy.defaultMomentPrivate === true;
      safe.privacySettings.hideReadReceipts = privacy.hideReadReceipts === true;
      safe.privacySettings.showMoodStatus = privacy.showMoodStatus !== false;
    }
    return safe;
  }

  async function requireTripMembership(tripId) {
    if (!tripId) throw new Error('缺少行程 ID');
    const { data } = await db.collection('trip_members')
      .where({ tripId, openid: OPENID })
      .limit(1)
      .get();
    if (!data.length) throw new Error('你还不是该行程成员');
    return data[0];
  }

  async function requireTripWritable(tripId) {
    const membership = await requireTripMembership(tripId);
    const { data: trip } = await db.collection('trips').doc(tripId).get();
    if (!trip) throw new Error('行程不存在');
    if (trip.status === 'archived') throw new Error('历史行程为只读，请先恢复行程');
    return { membership, trip };
  }

  function isCollectionNotFound(e) {
    const msg = (e && (e.message || e.errMsg || String(e))) || '';
    return msg.includes('DATABASE_COLLECTION_NOT_EXIST') ||
      msg.includes('collection not exists') ||
      msg.includes('Db or Table not exist') ||
      msg.includes('database request fail') ||
      msg.includes('-502001') ||
      msg.includes('-502005');
  }

  function isCollectionAlreadyExists(e) {
    const msg = (e && (e.message || e.errMsg || String(e))) || '';
    return msg.includes('already exists') ||
      msg.includes('collection exists') ||
      msg.includes('Table exist') ||
      msg.includes('ResourceExist') ||
      msg.includes('DATABASE_COLLECTION_ALREADY_EXIST') ||
      msg.includes('-501001');
  }

  async function ensureCollection(collectionName) {
    try {
      await db.createCollection(collectionName);
    } catch (e) {
      if (!isCollectionAlreadyExists(e)) {
        const msg = (e && (e.message || e.errMsg || String(e))) || '';
        console.warn(`ensureCollection ${collectionName} failed:`, msg);
        throw e;
      }
    }
  }

  async function getOwnedAiConversation(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id) return null;
    const { data } = await db.collection('ai_conversations')
      .where({ _id: id, ownerId: OPENID })
      .limit(1)
      .get();
    return data && data[0] ? data[0] : null;
  }

  function buildAiConversationTitle(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '新的对话';
    return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
  }

  function createAiMessage(role, text, actions = []) {
    const now = new Date().toISOString();
    const message = {
      id: `ai_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      text: String(text || '').slice(0, 12000),
      createdAt: now
    };
    if (Array.isArray(actions) && actions.length) message.actions = actions;
    return message;
  }

  function genInviteCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function normalizeTripData(data = {}) {
    const name = String(data.name || '').trim();
    const city = String(data.city || '').trim();
    const startDate = String(data.startDate || '');
    const endDate = String(data.endDate || '');
    if (!name) throw new Error('请输入行程名称');
    if (!city) throw new Error('请输入目的地');
    if (!startDate || !endDate) throw new Error('请选择日期');
    if (startDate > endDate) throw new Error('开始日期不能晚于结束日期');
    return {
      name,
      city,
      startDate,
      endDate,
      totalDays: Number(data.totalDays) || 1,
      totalBudget: Number(data.totalBudget) || 0,
      categoryBudgets: data.categoryBudgets || {},
      updatedAt: new Date().toISOString()
    };
  }

  switch (action) {

    case 'healthCheck':
      return { success: true, functionName: 'dbOps', version: CLOUD_VERSION };

    case 'getWeather': {
      const { city } = payload || {};
      if (!city) return { success: false, error: '缺少城市参数' };
      const qweatherKey = process.env.QWEATHER_KEY || '';
      const qweatherHost = String(process.env.QWEATHER_API_HOST || '').trim()
        .replace(/^https?:\/\//, '').replace(/\/$/, '');
      try {
        if (!qweatherKey) throw new Error('和风天气 Key 未配置');
        // 1. 城市查询 → location ID
        const authHeaders = qweatherHost ? { 'X-QW-Api-Key': qweatherKey } : {};
        const geoUrl = qweatherHost
          ? `https://${qweatherHost}/geo/v2/city/lookup?location=${encodeURIComponent(city)}&key=${encodeURIComponent(qweatherKey)}`
          : `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&key=${qweatherKey}`;
        const geoData = await requestJson(geoUrl, { headers: authHeaders });
        if (geoData.code !== '200' || !geoData.location || !geoData.location.length) {
          throw new Error(geoData.code === '404' ? '未找到该城市' : `城市查询失败 (${geoData.code || '未知'})`);
        }
        const locationId = geoData.location[0].id;
        // 2. 7 天预报
        const weatherUrl = qweatherHost
          ? `https://${qweatherHost}/v7/weather/7d?location=${encodeURIComponent(locationId)}&key=${encodeURIComponent(qweatherKey)}`
          : `https://devapi.qweather.com/v7/weather/7d?location=${encodeURIComponent(locationId)}&key=${qweatherKey}`;
        const weatherData = await requestJson(weatherUrl, { headers: authHeaders });
        if (weatherData.code !== '200' || !Array.isArray(weatherData.daily)) {
          throw new Error(`天气数据获取失败 (${weatherData.code || '未知'})`);
        }
        const weather = weatherData.daily.map(d => ({
          date: d.fxDate,
          dateShort: d.fxDate.slice(5),
          tempHigh: d.tempMax,
          tempLow: d.tempMin,
          textDay: d.textDay
        }));
        return { success: true, weather };
      } catch (qweatherError) {
        console.warn('和风天气不可用，切换备用数据源:', qweatherError.message);
        try {
          const weather = await getOpenMeteoWeather(city);
          return { success: true, weather, source: 'open-meteo' };
        } catch (fallbackError) {
          return {
            success: false,
            error: `天气加载失败：${fallbackError.message || qweatherError.message}`
          };
        }
      }
    }

    case 'tripLedgerAssistant': {
      const { tripId, text: rawText } = payload || {};
      const text = String(rawText || '').trim().slice(0, 300);
      if (!tripId || !text) return { success: false, error: '请输入账本问题' };
      try {
        await requireTripMembership(tripId);
        const [tripRes, membersRes] = await Promise.all([
          db.collection('trips').doc(tripId).get(),
          db.collection('trip_members').where({ tripId }).get()
        ]);
        let expenses = [];
        try {
          const expenseRes = await db.collection('expenses').where({ tripId }).limit(1000).get();
          expenses = expenseRes.data || [];
        } catch (error) {
          if (!isCollectionNotFound(error)) throw error;
        }
        const members = membersRes.data || [];
        const trip = tripRes.data || {};
        const explicitAmountMatch = text.match(/(?:¥|￥)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:元|块|rmb)/i);
        const plainNumberMatches = [...text.matchAll(/\d+(?:\.\d{1,2})?/g)];
        const amountMatch = explicitAmountMatch || plainNumberMatches.sort((a, b) => Number(b[0]) - Number(a[0]))[0];
        const createIntent = !!amountMatch && !/多少|总共|一共|合计|统计|查询|还剩/.test(text);

        if (createIntent) {
          const amount = Number(amountMatch[1] || amountMatch[2] || amountMatch[0].replace(/[^\d.]/g, ''));
          if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
            return { success: false, error: '金额不正确' };
          }
          const category = inferExpenseCategory(text);
          const shared = /aa|平摊|均摊|分摊|公共|大家|人均|我先付|\d+个?人/i.test(text);
          const currentMember = members.find(member => member.openid === OPENID) || {};
          const namedPayer = /我先付|我付的/.test(text)
            ? null
            : members.find(member => member.nickName && text.includes(member.nickName));
          const payer = namedPayer || currentMember || members[0] || {};
          let description = text
            .replace(amountMatch[0], '')
            .replace(/(?:帮我)?记(?:一)?笔|记账|入账|aa|平摊|均摊|分摊|我先付|我付的/gi, '')
            .replace(/\d+个?人/gi, '')
            .replace(/[，,。。：:]/g, ' ').trim();
          if (!description) description = `${EXPENSE_CATEGORY_LABELS[category]}支出`;
          const splitAmong = shared ? members.map(member => member.openid).filter(Boolean) : [];
          return {
            success: true,
            result: {
              type: 'expense_draft',
              draft: {
                tripId,
                type: shared ? 'shared' : 'private',
                category,
                categoryLabel: EXPENSE_CATEGORY_LABELS[category],
                amount,
                description: description.slice(0, 60),
                paidBy: payer.openid || OPENID,
                paidByName: payer.nickName || (payer.openid === OPENID ? '我' : '未知'),
                splitAmong,
                splitNames: shared ? members.map(member => member.nickName || '未命名').join('、') : '不分摊'
              }
            }
          };
        }

        const category = inferExpenseCategory(text);
        const asksSpecificCategory = category !== 'other';
        const selected = asksSpecificCategory ? expenses.filter(item => item.category === category) : expenses;
        const total = selected.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
        const allTotal = expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
        const budget = Number(trip.totalBudget) || 0;
        let answer;
        if (/谁付|付款人|垫付/.test(text)) {
          const payerTotals = {};
          expenses.forEach(item => {
            const name = item.paidByName || '未知';
            payerTotals[name] = (payerTotals[name] || 0) + (Number(item.amount) || 0);
          });
          const lines = Object.entries(payerTotals).sort((a, b) => b[1] - a[1])
            .map(([name, value]) => `${name} ¥${value.toFixed(2)}`);
          answer = lines.length ? `按付款人统计：${lines.join('，')}` : '还没有记账数据。';
        } else if (/预算|还剩|超支/.test(text)) {
          answer = budget
            ? `已支出 ¥${allTotal.toFixed(2)}，预算 ¥${budget.toFixed(2)}，${allTotal > budget ? `已超支 ¥${(allTotal - budget).toFixed(2)}` : `剩余 ¥${(budget - allTotal).toFixed(2)}`}。`
            : `已支出 ¥${allTotal.toFixed(2)}，还没设置总预算。`;
        } else {
          const label = asksSpecificCategory ? EXPENSE_CATEGORY_LABELS[category] : '全部';
          answer = selected.length
            ? `${label}支出共 ${selected.length} 笔，合计 ¥${total.toFixed(2)}。`
            : `还没有${asksSpecificCategory ? EXPENSE_CATEGORY_LABELS[category] : ''}支出记录。`;
        }
        return { success: true, result: { type: 'answer', answer } };
      } catch (error) {
        return { success: false, error: error.message || '账本助手暂时不可用' };
      }
    }

    case 'listAiConversations': {
      try {
        await ensureCollection('ai_conversations');
        const { data } = await db.collection('ai_conversations')
          .where({ ownerId: OPENID })
          .limit(100)
          .get();
        const conversations = (data || [])
          .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          .slice(0, 50)
          .map(item => ({
          _id: item._id,
          title: item.title || '新的对话',
          preview: item.preview || '',
          messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
          pinned: item.pinned === true,
          createdAt: item.createdAt || '',
          updatedAt: item.updatedAt || ''
          }));
        return { success: true, conversations };
      } catch (error) {
        return { success: false, error: error.message || '对话记录加载失败' };
      }
    }

    case 'getAiConversation': {
      try {
        await ensureCollection('ai_conversations');
        const conversation = await getOwnedAiConversation(payload && payload.conversationId);
        if (!conversation) return { success: false, error: '对话不存在或已删除' };
        return {
          success: true,
          conversation: {
            _id: conversation._id,
            title: conversation.title || '新的对话',
            messages: Array.isArray(conversation.messages) ? conversation.messages : [],
            createdAt: conversation.createdAt || '',
            updatedAt: conversation.updatedAt || ''
          }
        };
      } catch (error) {
        return { success: false, error: error.message || '对话加载失败' };
      }
    }

    case 'deleteAiConversation': {
      try {
        await ensureCollection('ai_conversations');
        const conversation = await getOwnedAiConversation(payload && payload.conversationId);
        if (!conversation) return { success: false, error: '对话不存在或已删除' };
        await db.collection('ai_conversations').doc(conversation._id).remove();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message || '删除对话失败' };
      }
    }

    case 'updateAiConversation': {
      try {
        await ensureCollection('ai_conversations');
        const conversation = await getOwnedAiConversation(payload && payload.conversationId);
        if (!conversation) return { success: false, error: '对话不存在或已删除' };
        const update = { updatedAt: new Date().toISOString() };
        if (payload && Object.prototype.hasOwnProperty.call(payload, 'title')) {
          const title = String(payload.title || '').replace(/\s+/g, ' ').trim().slice(0, 30);
          if (!title) return { success: false, error: '请输入对话名称' };
          update.title = title;
        }
        if (payload && Object.prototype.hasOwnProperty.call(payload, 'pinned')) {
          update.pinned = payload.pinned === true;
        }
        await db.collection('ai_conversations').doc(conversation._id).update({ data: update });
        return { success: true, conversation: { ...conversation, ...update } };
      } catch (error) {
        return { success: false, error: error.message || '更新对话失败' };
      }
    }

    case 'updateAiConversationAction': {
      try {
        await ensureCollection('ai_conversations');
        const conversation = await getOwnedAiConversation(payload && payload.conversationId);
        if (!conversation) return { success: false, error: '对话不存在或已删除' };
        const messageId = String(payload && payload.messageId || '');
        const actionId = String(payload && payload.actionId || '');
        const status = String(payload && payload.status || '');
        if (!['cancelled'].includes(status)) return { success: false, error: '操作状态无效' };
        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        const message = messages.find(item => item.id === messageId);
        const action = message && Array.isArray(message.actions)
          ? message.actions.find(item => item.id === actionId)
          : null;
        if (!action) return { success: false, error: '待处理操作不存在' };
        if (action.status !== 'pending') return { success: false, error: '该操作已处理' };
        action.status = status;
        action.updatedAt = new Date().toISOString();
        await db.collection('ai_conversations').doc(conversation._id).update({
          data: { messages, updatedAt: new Date().toISOString() }
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message || '更新操作状态失败' };
      }
    }

    case 'aiChat': {
      const { text: rawText, history, conversationId: rawConversationId } = payload || {};
      const text = String(rawText || '').trim().slice(0, 500);
      if (!text) return { success: false, error: '请输入想问的问题' };
      const apiKey = process.env.ZHIPU_API_KEY || '';
      if (!apiKey) return { success: false, error: 'AI 服务未配置' };
      try {
        await ensureCollection('ai_conversations');
        const conversationId = String(rawConversationId || '').trim();
        const conversation = conversationId ? await getOwnedAiConversation(conversationId) : null;
        if (conversationId && !conversation) return { success: false, error: '对话不存在或已删除' };
        const storedMessages = conversation && Array.isArray(conversation.messages)
          ? conversation.messages
            .filter(item => item && ['user', 'assistant'].includes(item.role) && item.text)
            .slice(-20)
            .map(item => ({ role: item.role, content: String(item.text).slice(0, 12000) }))
          : [];
        const messages = [
          { role: 'system', content: XIXI_SYSTEM_PROMPT },
          ...(storedMessages.length ? storedMessages : (history || []).slice(-20)),
          { role: 'user', content: text }
        ];
        // 第一轮：AI 决定是否调用工具。写操作只生成草稿，确认后才执行。
        const resp = await callZhipuWithTools(apiKey, messages, XIXI_TOOLS);
        const actions = [];
        let answer = resp.content || '让我想想...';
        if (resp.tool_calls && resp.tool_calls.length > 0) {
          const toolMessages = [{ role: 'assistant', content: resp.content || '', tool_calls: resp.tool_calls }];
          for (let index = 0; index < resp.tool_calls.length; index += 1) {
            const tc = resp.tool_calls[index];
            const toolName = tc.function?.name;
            const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
            let result;
            if (XIXI_WRITE_TOOLS.has(toolName)) {
              const preview = getXixiActionPreview(toolName, args);
              result = { ok: true, pending: true, msg: '等待用户确认' };
              actions.push({
                id: `ai_action_${Date.now()}_${index}`,
                tool: toolName,
                args,
                status: 'pending',
                title: preview.title,
                detail: preview.detail,
                result
              });
            } else {
              result = await executeXixiTool(db, OPENID, toolName, args);
              actions.push({
                id: `ai_action_${Date.now()}_${index}`,
                tool: toolName,
                status: result.ok ? 'done' : 'failed',
                title: getXixiActionPreview(toolName, args).title,
                detail: result.msg || '',
                result
              });
            }
            toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          }
          // 第二轮：AI 根据工具结果生成最终回复
          const finalResp = await callZhipuWithTools(apiKey, [...messages, ...toolMessages], []);
          answer = finalResp.content || '操作已完成';
        }
        const userMessage = createAiMessage('user', text);
        const assistantMessage = createAiMessage('assistant', answer, actions);
        const now = new Date().toISOString();
        let savedConversationId = conversation && conversation._id;
        let title = conversation && conversation.title;
        if (conversation) {
          const nextMessages = [...(conversation.messages || []), userMessage, assistantMessage].slice(-100);
          await db.collection('ai_conversations').doc(conversation._id).update({
            data: {
              messages: nextMessages,
              preview: String(answer).replace(/\s+/g, ' ').slice(0, 60),
              updatedAt: now
            }
          });
        } else {
          title = buildAiConversationTitle(text);
          const added = await db.collection('ai_conversations').add({
            data: {
              ownerId: OPENID,
              title,
              preview: String(answer).replace(/\s+/g, ' ').slice(0, 60),
              messages: [userMessage, assistantMessage],
              createdAt: now,
              updatedAt: now
            }
          });
          savedConversationId = added._id;
        }
        return {
          success: true,
          conversationId: savedConversationId,
          title: title || buildAiConversationTitle(text),
          userMessage,
          assistantMessage,
          text: answer,
          actions
        };
      } catch (error) {
        return { success: false, error: error.message || '拾途 AI 暂时不可用' };
      }
    }

    case 'confirmAiAction': {
      const tool = String(payload && payload.tool || '');
      const args = payload && payload.args;
      if (!XIXI_WRITE_TOOLS.has(tool)) return { success: false, error: '不支持的 AI 操作' };
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { success: false, error: '操作参数无效' };
      try {
        await ensureCollection('ai_conversations');
        const conversationId = String(payload && payload.conversationId || '');
        const messageId = String(payload && payload.messageId || '');
        const actionId = String(payload && payload.actionId || '');
        const conversation = conversationId ? await getOwnedAiConversation(conversationId) : null;
        if (conversationId && !conversation) return { success: false, error: '对话不存在或已删除' };
        let messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
        let action = null;
        if (conversation) {
          const message = messages.find(item => item.id === messageId);
          action = message && Array.isArray(message.actions)
            ? message.actions.find(item => item.id === actionId)
            : null;
          if (!action || action.tool !== tool) return { success: false, error: '待处理操作不存在' };
          if (action.status !== 'pending') return { success: false, error: '该操作已处理' };
        }
        const result = await executeXixiTool(db, OPENID, tool, args);
        let assistantMessage = null;
        if (conversation && action) {
          action.status = result.ok ? 'done' : 'failed';
          action.result = result;
          action.updatedAt = new Date().toISOString();
          if (result.ok) {
            assistantMessage = createAiMessage('assistant', result.msg || '操作已完成');
            messages = [...messages, assistantMessage].slice(-100);
          }
          await db.collection('ai_conversations').doc(conversation._id).update({
            data: {
              messages,
              preview: result.msg || conversation.preview || '',
              updatedAt: new Date().toISOString()
            }
          });
        }
        return { success: !!result.ok, result, assistantMessage, error: result.ok ? '' : result.msg };
      } catch (error) {
        return { success: false, error: error.message || 'AI 操作执行失败' };
      }
    }

    case 'globalTravelAssistant': {
      const { text: rawText, tripId } = payload || {};
      const text = String(rawText || '').trim().slice(0, 3000);
      if (!text) return { success: false, error: '请输入想问的问题' };
      const apiKey = process.env.ZHIPU_API_KEY || '';
      if (!apiKey) return { success: false, error: 'AI 服务未配置' };
      try {
        let tripContext = '当前没有选中行程。';
        if (tripId) {
          await requireTripMembership(tripId);
          const [tripRes, membersRes, plansRes] = await Promise.all([
            db.collection('trips').doc(tripId).get(),
            db.collection('trip_members').where({ tripId }).limit(100).get(),
            db.collection('day_plans').where({ tripId }).orderBy('dayIndex', 'asc').limit(30).get()
          ]);
          const trip = tripRes.data;
          if (trip) {
            let expenses = [];
            try {
              const expenseRes = await db.collection('expenses').where({ tripId }).orderBy('createdAt', 'desc').limit(80).get();
              expenses = expenseRes.data || [];
            } catch (error) {
              if (!isCollectionNotFound(error)) throw error;
            }
            const members = (membersRes.data || []).map(member => member.nickName || (member.openid === OPENID ? '我' : '成员')).filter(Boolean);
            const planLines = (plansRes.data || []).slice(0, 8).map(day => {
              const items = (day.items || []).slice(0, 8).map(item => `${item.time || '时间待定'} ${item.title || '安排'}${item.location ? `@${item.location}` : ''}`).join('；');
              return `Day ${day.dayIndex || ''} ${day.date || ''}：${items || '暂无安排'}`;
            });
            const expenseTotal = expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
            const expenseLines = expenses.slice(0, 8).map(item => `${item.description || '支出'} ¥${Number(item.amount || 0).toFixed(2)} ${item.category || 'other'}`).join('；');
            tripContext = [
              `当前行程：${trip.name || ''}，目的地 ${trip.city || ''}，${trip.startDate || ''} 至 ${trip.endDate || ''}，${trip.totalDays || 1} 天。`,
              members.length ? `成员：${members.join('、')}。` : '',
              planLines.length ? `已有日程：\n${planLines.join('\n')}` : '已有日程：暂未填写。',
              `账本概况：${expenses.length} 笔，合计约 ¥${expenseTotal.toFixed(2)}。${expenseLines ? `最近记录：${expenseLines}` : ''}`
            ].filter(Boolean).join('\n');
          }
        }
        const answer = await callZhipuText(
          apiKey,
          `${XIXI_SYSTEM_PROMPT}

## 通用咨询补充规则
- 这里不能调用写入工具，所以只回答、分析、草拟方案；如果需要真的写入行程/账本，明确告诉用户“我可以整理草案，确认后再保存”
- 当用户问“规划详情”“怎么安排”“你觉得怎么做”时，直接给出可执行方案：按时间、地点、预算、风险和取舍展开，不要重复一句模板话
- 能根据当前行程数据回答就必须结合数据；数据不足时先声明你的假设，再给可修改版本
- 回复要像一个聪明朋友：有判断、有层次、有原因；不要机械复述“可以帮你规划”
- 不使用 emoji`,
          `${tripContext}\n\n用户问：${text}`
        );
        return { success: true, answer };
      } catch (error) {
        return { success: false, error: error.message || 'AI 助手暂时不可用' };
      }
    }

    case 'generateTripPlan': {
      const { tripId, city, totalDays, preferences } = payload || {};
      const apiKey = process.env.ZHIPU_API_KEY || '';
      if (!apiKey) return { success: false, error: 'AI 服务未配置' };
      if (!city || !totalDays) return { success: false, error: '缺少城市或天数' };
      try {
        await requireTripMembership(tripId);
        const days = Math.min(Math.max(Number(totalDays) || 1, 1), 14);
        const prefs = String(preferences || '').slice(0, 200);
        const systemPrompt = `你是一个专业的旅行规划师。根据用户提供的城市、天数、偏好，生成一份详细的分天行程。
必须只输出 JSON，不要 markdown 标记，不要额外文字。格式：
{ "days": [{ "dayIndex": 1, "items": [{ "title": "景点或活动名", "type": "spot|food|hotel|transport|shopping|other", "time": "09:00", "notes": "备注", "location": "地点名" }] }] }
规则：
- 每天 3-5 个活动，时间从早到晚合理分布
- type 根据内容判断：景点=spot，餐饮=food，住宿=hotel，交通=transport
- 如果没有明确的 type 对应，填 other
- title 简洁，location 是可选的，notes 是可选的
- 根据偏好调整内容，如"美食优先"多安排知名餐厅`;
        const userMessage = `请为${city}规划一份${days}天旅行行程${prefs ? '，偏好：' + prefs : ''}。`;
        const aiResult = await new Promise((resolve, reject) => {
          const body = JSON.stringify({
            model: process.env.ZHIPU_MODEL || 'glm-4',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage }
            ],
            temperature: 0.5,
            max_tokens: Math.min(2400, 500 + days * 260),
            stream: true
          });
          const req = https.request('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            timeout: 50000,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Authorization': `Bearer ${apiKey}`,
              'Content-Length': Buffer.byteLength(body)
            }
          }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => {
              try {
                let text = '';
                if (data.includes('data:')) {
                  data.split(/\r?\n/).forEach(line => {
                    if (!line.startsWith('data:')) return;
                    const payloadText = line.slice(5).trim();
                    if (!payloadText || payloadText === '[DONE]') return;
                    const chunk = JSON.parse(payloadText);
                    if (chunk.error) throw new Error(chunk.error.message || 'AI 调用失败');
                    const choice = chunk.choices && chunk.choices[0];
                    text += (choice && choice.delta && choice.delta.content) ||
                      (choice && choice.message && choice.message.content) || '';
                  });
                } else {
                  const json = JSON.parse(data);
                  if (json.error) throw new Error(json.error.message || 'AI 调用失败');
                  text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
                }
                if (!text.trim()) throw new Error(`AI 未返回内容 (HTTP ${res.statusCode || '未知'})`);
                // 清理可能的 markdown 包裹
                const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                const jsonStart = clean.indexOf('{');
                const jsonEnd = clean.lastIndexOf('}');
                if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('AI 未返回 JSON');
                const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
                resolve(parsed);
              } catch (e) {
                reject(new Error(e.message || 'AI 返回格式异常，请重试'));
              }
            });
          });
          req.on('timeout', () => req.destroy(new Error('AI 生成超时')));
          req.on('error', reject);
          req.write(body);
          req.end();
        });
        // 校验结构
        if (!aiResult.days || !Array.isArray(aiResult.days)) {
          throw new Error('AI 返回数据格式不正确');
        }
        aiResult.days = aiResult.days.slice(0, days).map(day => ({
          dayIndex: Number(day.dayIndex) || 1,
          items: (day.items || []).slice(0, 6).map(item => ({
            title: String(item.title || '').slice(0, 100),
            type: ['spot','food','hotel','transport','shopping','other'].includes(item.type) ? item.type : 'spot',
            time: String(item.time || '').slice(0, 5),
            notes: String(item.notes || '').slice(0, 200),
            location: String(item.location || '').slice(0, 100)
          }))
        }));
        return { success: true, plan: aiResult };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 更新自己的用户信息
    case 'upsertUser': {
      const { nickName, avatarUrl, avatarThumbUrl, signature } = payload;
      try {
        await ensureCollection('users');
        const updateData = { uid: OPENID, openid: OPENID, updatedAt: new Date().toISOString() };
        if (typeof nickName === 'string' && nickName.trim()) updateData.nickName = nickName.trim();
        if (typeof avatarUrl === 'string' && avatarUrl) updateData.avatarUrl = avatarUrl;
        if (typeof avatarThumbUrl === 'string' && avatarThumbUrl) updateData.avatarThumbUrl = avatarThumbUrl;
        if (typeof signature === 'string') updateData.signature = signature.trim().slice(0, 60);
        const user = await getUserByIdentity(OPENID);
        if (user) {
          await ensurePublicId(user);
          await db.collection('users').doc(user._id).update({ data: updateData });
        } else {
          await db.collection('users').add({
            data: {
              openid: OPENID,
              uid: OPENID,
              publicId: await createUniquePublicId(),
              nickName: updateData.nickName || '',
              avatarUrl: updateData.avatarUrl || '',
              avatarThumbUrl: updateData.avatarThumbUrl || '',
              signature: updateData.signature || '',
              updatedAt: updateData.updatedAt
            }
          });
        }
        const syncResult = await (async () => {
          const memberUpdate = {};
          const momentUpdate = {};
          if (updateData.nickName) {
            memberUpdate.nickName = updateData.nickName;
            momentUpdate.authorName = updateData.nickName;
          }
          if (updateData.avatarUrl) {
            memberUpdate.avatarUrl = updateData.avatarUrl;
            momentUpdate.authorAvatar = updateData.avatarUrl;
          }
          if (updateData.avatarThumbUrl) {
            memberUpdate.avatarThumbUrl = updateData.avatarThumbUrl;
            momentUpdate.authorAvatarThumb = updateData.avatarThumbUrl;
          }
          if (Object.keys(memberUpdate).length === 0) return { updatedMembers: 0, updatedMoments: 0 };
          const [updatedMembers, updatedMoments] = await Promise.all([
            updateByOpenid('trip_members', 'openid', OPENID, memberUpdate),
            updateByOpenid('moments', 'authorId', OPENID, momentUpdate)
          ]);
          return { updatedMembers, updatedMoments };
        })();
        return { success: true, ...syncResult };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'updateUserSettings': {
      const { privacySettings, showBadge } = payload;
      try {
        await ensureCollection('users');
        const updateData = { uid: OPENID, openid: OPENID, updatedAt: new Date().toISOString() };
        if (privacySettings && typeof privacySettings === 'object') {
        updateData.privacySettings = {
          allowProfileView: privacySettings.allowProfileView !== false,
          allowPrivateMessage: privacySettings.allowPrivateMessage !== false,
          defaultMomentPrivate: privacySettings.defaultMomentPrivate === true,
          hideReadReceipts: privacySettings.hideReadReceipts === true,
          showMoodStatus: privacySettings.showMoodStatus !== false
          };
        }
        // 徽章显示开关（跟随隐私设置一起保存）
        if (typeof showBadge === 'boolean') {
          updateData.showBadge = showBadge;
        }
        const user = await getUserByIdentity(OPENID);
        if (user) {
          await ensurePublicId(user);
          await db.collection('users').doc(user._id).update({ data: updateData });
        } else {
          await db.collection('users').add({
            data: {
              openid: OPENID,
              uid: OPENID,
              publicId: await createUniquePublicId(),
              nickName: '',
              avatarUrl: '',
              signature: '',
              privacySettings: updateData.privacySettings || {},
              showBadge: updateData.showBadge !== undefined ? updateData.showBadge : true,
              updatedAt: updateData.updatedAt
            }
          });
        }
        return { success: true, settings: updateData };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 佩戴/取下徽章
    case 'setWornBadge': {
      const { wornBadge } = payload;
      try {
        await ensureCollection('users');
        const user = await getUserByIdentity(OPENID);
        if (!user) return { success: false, error: '用户不存在' };
        const updateData = {
          wornBadge: wornBadge || db.command.remove(),
          updatedAt: new Date().toISOString()
        };
        await db.collection('users').doc(user._id).update({ data: updateData });
        return { success: true, wornBadge: wornBadge || '' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 关注/取关（follower 固定为当前用户）
    case 'toggleFollow': {
      const { following } = payload;
      if (!following || following === OPENID) {
        return { success: false, error: '不能关注自己' };
      }
      try {
        await ensureCollection('follows');
        const { data } = await db.collection('follows')
          .where({ follower: OPENID, following })
          .get();
        if (data.length > 0) {
          await db.collection('follows').doc(data[0]._id).remove();
          return { success: true, followed: false };
        } else {
          await db.collection('follows').add({
            data: { follower: OPENID, following, createdAt: new Date().toISOString() }
          });
          return { success: true, followed: true };
        }
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 查询用户信息
    case 'getUserProfile': {
      const { openid } = payload;
      if (!openid) return { success: false, error: '缺少 openid' };
      try {
        let user = await getUserByIdentity(openid);
        if (user) user = await ensurePublicId(user);
        const safe = toSafeUser(user, openid === OPENID);
        // 如果是自己且状态已过期，异步清理数据库
        if (openid === OPENID && user && user.moodUpdatedAt) {
          const elapsed = Date.now() - new Date(user.moodUpdatedAt).getTime();
          if (elapsed > 24 * 60 * 60 * 1000) {
            db.collection('users').doc(user._id).update({
              data: {
                moodEmoji: db.command.remove(),
                moodText: db.command.remove(),
                moodUpdatedAt: db.command.remove()
              }
            }).catch(() => {});
          }
        }
        return { success: true, user: safe };
      } catch (e) {
        if (isCollectionNotFound(e)) return { success: true, user: null };
        return { success: false, error: e.message };
      }
    }

    case 'setMood': {
      const emoji = String(payload.emoji || '').trim().slice(0, 8);
      const text = String(payload.text || '').trim().slice(0, 30);
      if (!emoji && !text) return { success: false, error: '心情内容不能为空' };
      try {
        await ensureCollection('users');
        const user = await getUserByIdentity(OPENID);
        if (!user) return { success: false, error: '用户不存在' };
        await db.collection('users').doc(user._id).update({
          data: {
            moodEmoji: emoji,
            moodText: text,
            moodUpdatedAt: new Date().toISOString()
          }
        });
        return { success: true, moodEmoji: emoji, moodText: text };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'clearMood': {
      try {
        await ensureCollection('users');
        const user = await getUserByIdentity(OPENID);
        if (!user) return { success: false, error: '用户不存在' };
        await db.collection('users').doc(user._id).update({
          data: {
            moodEmoji: db.command.remove(),
            moodText: db.command.remove(),
            moodUpdatedAt: db.command.remove()
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'updatePublicId': {
      const publicId = String(payload.publicId || '').trim();
      if (!/^\d{6}$/.test(publicId)) {
        return { success: false, error: 'ID 必须是 6 位数字' };
      }
      try {
        await ensureCollection('users');
        const { data: duplicates } = await db.collection('users').where({ publicId }).limit(2).get();
        const occupied = (duplicates || []).some(user => (user.openid || user.uid) !== OPENID);
        if (occupied) return { success: false, error: '这个 ID 已被使用' };
        const user = await getUserByIdentity(OPENID);
        if (!user) return { success: false, error: '用户资料不存在，请重新进入小程序' };
        await db.collection('users').doc(user._id).update({
          data: { publicId, updatedAt: new Date().toISOString() }
        });
        return { success: true, publicId };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 关注统计
    case 'getFollowStats': {
      const { openid } = payload;
      if (!openid) return { success: false, error: '缺少 openid' };
      try {
        await ensureCollection('follows');
        const [following, followers] = await Promise.all([
          db.collection('follows').where({ follower: openid }).count(),
          db.collection('follows').where({ following: openid }).count()
        ]);
        return { success: true, stats: { following: following.total || 0, followers: followers.total || 0 } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 是否已关注
    case 'isFollowing': {
      const { target } = payload;
      if (!target) return { success: false, following: false };
      try {
        await ensureCollection('follows');
        const { data } = await db.collection('follows').where({ follower: OPENID, following: target }).get();
        return { success: true, following: data.length > 0 };
      } catch (e) {
        return { success: false, following: false };
      }
    }

    case 'getSocialRelationship': {
      const { targetOpenid } = payload;
      if (!targetOpenid) return { success: false, error: '缺少用户标识' };
      try {
        await ensureCollection('follows');
        const [followRes, followedByRes, friend] = await Promise.all([
          db.collection('follows').where({ follower: OPENID, following: targetOpenid }).limit(1).get(),
          db.collection('follows').where({ follower: targetOpenid, following: OPENID }).limit(1).get(),
          getFriendState(targetOpenid)
        ]);
        return {
          success: true,
          following: (followRes.data || []).length > 0,
          followedBy: (followedByRes.data || []).length > 0,
          friend
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'searchUserByPublicId': {
      const publicId = String(payload.publicId || '').trim();
      if (!/^\d{6}$/.test(publicId)) return { success: false, error: '请输入 6 位数字 ID' };
      try {
        await ensureCollection('users');
        const { data } = await db.collection('users').where({ publicId }).limit(1).get();
        if (!data.length) return { success: true, user: null, friend: { status: 'none', requestId: '' } };
        const user = data[0];
        const friend = await getFriendState(user.openid || user.uid);
        return {
          success: true,
          user: {
            openid: user.openid || user.uid,
            publicId: user.publicId,
            nickName: user.nickName || '未设置',
            avatarUrl: user.avatarUrl || '',
            signature: user.signature || ''
          },
          friend
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'sendFriendRequest': {
      const { targetOpenid } = payload;
      if (!targetOpenid || targetOpenid === OPENID) return { success: false, error: '不能添加自己' };
      try {
        const target = await getUserByIdentity(targetOpenid);
        if (!target) return { success: false, error: '用户不存在' };
        await ensureCollection('friend_requests');
        const state = await getFriendState(targetOpenid);
        if (state.status === 'friends') return { success: true, friend: state };
        if (state.status === 'outgoing') return { success: true, friend: state };
        if (state.status === 'incoming') {
          await db.collection('friend_requests').doc(state.requestId).update({
            data: { status: 'accepted', respondedAt: new Date().toISOString() }
          });
          return { success: true, friend: { status: 'friends', requestId: state.requestId } };
        }
        const res = await db.collection('friend_requests').add({
          data: {
            from: OPENID,
            to: targetOpenid,
            status: 'pending',
            createdAt: new Date().toISOString(),
            respondedAt: ''
          }
        });
        return { success: true, friend: { status: 'outgoing', requestId: res._id } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'respondFriendRequest': {
      const { requestId, accept } = payload;
      if (!requestId) return { success: false, error: '缺少好友申请' };
      try {
        const { data: request } = await db.collection('friend_requests').doc(requestId).get();
        if (!request || request.to !== OPENID || request.status !== 'pending') {
          return { success: false, error: '好友申请已失效' };
        }
        const status = accept ? 'accepted' : 'rejected';
        await db.collection('friend_requests').doc(requestId).update({
          data: { status, respondedAt: new Date().toISOString() }
        });
        return { success: true, status };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getFriendCenter': {
      try {
        await ensureCollection('friend_requests');
        const [incomingRes, fromAccepted, toAccepted, outgoingRes] = await Promise.all([
          db.collection('friend_requests').where({ to: OPENID, status: 'pending' }).orderBy('createdAt', 'desc').limit(100).get(),
          db.collection('friend_requests').where({ from: OPENID, status: 'accepted' }).limit(100).get(),
          db.collection('friend_requests').where({ to: OPENID, status: 'accepted' }).limit(100).get(),
          db.collection('friend_requests').where({ from: OPENID, status: 'pending' }).limit(100).get()
        ]);
        const incoming = incomingRes.data || [];
        const accepted = [...(fromAccepted.data || []), ...(toAccepted.data || [])];
        const friendIds = [...new Set(accepted.map(item => item.from === OPENID ? item.to : item.from))];
        const incomingIds = incoming.map(item => item.from);
        const userMap = await getUsersByOpenids([...friendIds, ...incomingIds]);
        await Promise.all(Object.values(userMap).map(user => ensurePublicId(user)));
        const toPublicUser = (openid) => {
          const user = userMap[openid] || {};
          return {
            openid,
            publicId: user.publicId || '',
            nickName: user.nickName || '未设置',
            avatarUrl: user.avatarUrl || '',
            signature: user.signature || ''
          };
        };
        return {
          success: true,
          incoming: incoming.map(item => ({ requestId: item._id, createdAt: item.createdAt, user: toPublicUser(item.from) })),
          friends: friendIds.map(toPublicUser),
          outgoingOpenids: (outgoingRes.data || []).map(item => item.to)
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getSocialPreferences': {
      try {
        const user = await getUserByIdentity(OPENID);
        return {
          success: true,
          blockedOpenids: (user && user.blockedOpenids) || [],
          hiddenMomentOpenids: (user && user.hiddenMomentOpenids) || [],
          hiddenReadReceiptOpenids: (user && user.hiddenReadReceiptOpenids) || [],
          visibleReadReceiptOpenids: (user && user.visibleReadReceiptOpenids) || [],
          hideReadReceipts: !!(user && user.privacySettings && user.privacySettings.hideReadReceipts)
        };
      } catch (e) {
        if (isCollectionNotFound(e)) {
          return { success: true, blockedOpenids: [], hiddenMomentOpenids: [], hiddenReadReceiptOpenids: [], visibleReadReceiptOpenids: [], hideReadReceipts: false };
        }
        return { success: false, error: e.message };
      }
    }

    case 'updateSocialPreference': {
      const { targetOpenid, preference, enabled } = payload;
      if (!targetOpenid || targetOpenid === OPENID) return { success: false, error: '无效用户' };
      if (!['blocked', 'hiddenMoments', 'readReceipts'].includes(preference)) return { success: false, error: '无效设置' };
      try {
        const user = await getUserByIdentity(OPENID);
        if (!user) return { success: false, error: '用户资料不存在' };
        if (preference === 'readReceipts') {
          const hidden = new Set(user.hiddenReadReceiptOpenids || []);
          const visible = new Set(user.visibleReadReceiptOpenids || []);
          if (enabled) {
            visible.add(targetOpenid);
            hidden.delete(targetOpenid);
          } else {
            hidden.add(targetOpenid);
            visible.delete(targetOpenid);
          }
          await db.collection('users').doc(user._id).update({
            data: { hiddenReadReceiptOpenids: [...hidden], visibleReadReceiptOpenids: [...visible] }
          });
          return { success: true, enabled: enabled === true };
        }
        const field = preference === 'blocked' ? 'blockedOpenids' : 'hiddenMomentOpenids';
        const values = new Set(user[field] || []);
        if (enabled) values.add(targetOpenid);
        else values.delete(targetOpenid);
        await db.collection('users').doc(user._id).update({ data: { [field]: [...values] } });
        if (preference === 'blocked' && enabled) {
          const requests = await getFriendRequestsBetween(OPENID, targetOpenid);
          await Promise.all(requests
            .filter(item => item.status === 'accepted' || item.status === 'pending')
            .map(item => db.collection('friend_requests').doc(item._id).update({
              data: { status: 'deleted', respondedAt: new Date().toISOString() }
            })));
        }
        return { success: true, enabled: enabled === true, values: [...values] };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'deleteFriend': {
      const { targetOpenid } = payload;
      if (!targetOpenid) return { success: false, error: '缺少好友' };
      try {
        const requests = await getFriendRequestsBetween(OPENID, targetOpenid);
        const accepted = requests.filter(item => item.status === 'accepted');
        if (!accepted.length) return { success: true };
        await Promise.all(accepted.map(item => db.collection('friend_requests').doc(item._id).update({
          data: { status: 'deleted', respondedAt: new Date().toISOString() }
        })));
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 关注/粉丝列表
    case 'getFollowList': {
      const { openid, type } = payload;
      if (!openid) return { success: false, list: [] };
      try {
        await ensureCollection('follows');
        let { data } = type === 'following'
          ? await db.collection('follows').where({ follower: openid }).orderBy('createdAt', 'desc').limit(200).get()
          : await db.collection('follows').where({ following: openid }).orderBy('createdAt', 'desc').limit(200).get();

        const userIds = data.map(d => type === 'following' ? d.following : d.follower);
        return { success: true, openids: userIds };
      } catch (e) {
        return { success: false, list: [] };
      }
    }

    // 批量获取用户信息
    case 'batchGetUsers': {
      const { openids } = payload;
      if (!openids || !openids.length) return { success: true, users: {} };
      try {
        const uniqOpenids = [...new Set(openids)].filter(Boolean);
        const batchSize = 50;
        const data = [];
        for (let i = 0; i < uniqOpenids.length; i += batchSize) {
          const batch = uniqOpenids.slice(i, i + batchSize);
          try {
            const [openidRes, uidRes] = await Promise.all([
              db.collection('users').where({ openid: _.in(batch) }).get(),
              db.collection('users').where({ uid: _.in(batch) }).get()
            ]);
            const byId = {};
            [...(openidRes.data || []), ...(uidRes.data || [])].forEach(user => {
              byId[user._id] = user;
            });
            data.push(...Object.values(byId));
          } catch (e) {
            if (!isCollectionNotFound(e)) throw e;
          }
        }
        const map = {};
        data.forEach(u => {
          const key = u.openid || u.uid;
          if (key) map[key] = toSafeUser(u, false);
        });
        return { success: true, users: map };
      } catch (e) {
        return { success: false, users: {} };
      }
    }

    // 同步用户信息到成员记录和历史动态作者信息
    case 'syncProfile': {
      const { nickName, avatarUrl } = payload;
      try {
        const memberUpdate = {};
        const momentUpdate = {};
        if (nickName) {
          memberUpdate.nickName = nickName;
          momentUpdate.authorName = nickName;
        }
        if (avatarUrl) {
          memberUpdate.avatarUrl = avatarUrl;
          momentUpdate.authorAvatar = avatarUrl;
        }
        if (Object.keys(memberUpdate).length === 0) {
          return { success: true, updatedMembers: 0, updatedMoments: 0 };
        }
        const [updatedMembers, updatedMoments] = await Promise.all([
          updateByOpenid('trip_members', 'openid', OPENID, memberUpdate),
          updateByOpenid('moments', 'authorId', OPENID, momentUpdate)
        ]);
        return { success: true, updatedMembers, updatedMoments };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'createTrip': {
      try {
        const tripData = normalizeTripData(payload.trip || {});
        tripData.creatorId = OPENID;
        tripData.status = 'active';
        tripData.createdAt = new Date().toISOString();

        const tripRes = await db.collection('trips').add({ data: tripData });
        const tripId = tripRes._id;
        const inviteCode = genInviteCode();

        let nickName = '我';
        let avatarUrl = '';
        try {
          const user = await getUserByIdentity(OPENID);
          if (user) {
            nickName = user.nickName || nickName;
            avatarUrl = user.avatarUrl || '';
          }
        } catch (_) {}

        await db.collection('trip_members').add({
          data: {
            tripId,
            openid: OPENID,
            nickName,
            avatarUrl,
            role: 'creator',
            inviteCode
          }
        });
        try {
          const user = await getUserByIdentity(OPENID);
          if (user && !user.currentTripId) {
            await db.collection('users').doc(user._id).update({
              data: { currentTripId: tripId, updatedAt: new Date().toISOString() }
            });
          }
        } catch (_) {}
        return { success: true, tripId, inviteCode };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'saveTripTemplate': {
      const { tripId, name: rawName } = payload || {};
      if (!tripId) return { success: false, error: '缺少行程 ID' };
      try {
        await requireTripMembership(tripId);
        await ensureCollection('trip_templates');
        const [tripRes, plansRes] = await Promise.all([
          db.collection('trips').doc(tripId).get(),
          db.collection('day_plans').where({ tripId }).orderBy('dayIndex', 'asc').get()
        ]);
        const trip = tripRes.data;
        if (!trip) throw new Error('行程不存在');
        const now = new Date().toISOString();
        const planDays = (plansRes.data || []).slice(0, 60).map(day => ({
          dayIndex: Number(day.dayIndex) || 1,
          items: sanitizeReusablePlanItems(day.items, `tpl_${Date.now().toString(36)}_${day.dayIndex}`)
        }));
        const templateData = {
          ownerId: OPENID,
          sourceTripId: tripId,
          sourceTripName: trip.name || '',
          name: String(rawName || `${trip.name || trip.city || '行程'}模板`).trim().slice(0, 40),
          city: String(trip.city || '').slice(0, 40),
          totalDays: Number(trip.totalDays) || Math.max(planDays.length, 1),
          planDays,
          createdAt: now,
          updatedAt: now
        };
        const result = await db.collection('trip_templates').add({ data: templateData });
        return { success: true, templateId: result._id, template: { _id: result._id, ...templateData } };
      } catch (error) {
        return { success: false, error: error.message || '保存模板失败' };
      }
    }

    case 'getTripTemplates': {
      try {
        await ensureCollection('trip_templates');
        const { data } = await db.collection('trip_templates').where({ ownerId: OPENID }).limit(100).get();
        const templates = (data || [])
          .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
          .map(item => ({
            _id: item._id,
            name: item.name || '未命名模板',
            city: item.city || '',
            totalDays: Number(item.totalDays) || 1,
            activityCount: (item.planDays || []).reduce((sum, day) => sum + (day.items || []).length, 0),
            updatedAt: item.updatedAt || item.createdAt || ''
          }));
        return { success: true, templates };
      } catch (error) {
        if (isCollectionNotFound(error)) return { success: true, templates: [] };
        return { success: false, error: error.message || '获取模板失败' };
      }
    }

    case 'getTripTemplate': {
      const templateId = String(payload && payload.templateId || '');
      if (!templateId) return { success: false, error: '缺少模板 ID' };
      try {
        await ensureCollection('trip_templates');
        const { data: template } = await db.collection('trip_templates').doc(templateId).get();
        if (!template || template.ownerId !== OPENID) throw new Error('模板不存在');
        return { success: true, template };
      } catch (error) {
        return { success: false, error: error.message || '获取模板失败' };
      }
    }

    case 'deleteTripTemplate': {
      const templateId = String(payload && payload.templateId || '');
      if (!templateId) return { success: false, error: '缺少模板 ID' };
      try {
        const { data: template } = await db.collection('trip_templates').doc(templateId).get();
        if (!template || template.ownerId !== OPENID) throw new Error('模板不存在');
        await db.collection('trip_templates').doc(templateId).remove();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message || '删除模板失败' };
      }
    }

    case 'createTripFromSource': {
      const { sourceTripId, templateId } = payload || {};
      try {
        const tripData = normalizeTripData(payload.trip || {});
        let reusableDays = [];
        let sourceName = '';
        if (sourceTripId) {
          await requireTripMembership(sourceTripId);
          const [sourceTripRes, plansRes] = await Promise.all([
            db.collection('trips').doc(sourceTripId).get(),
            db.collection('day_plans').where({ tripId: sourceTripId }).orderBy('dayIndex', 'asc').get()
          ]);
          if (!sourceTripRes.data) throw new Error('历史行程不存在');
          sourceName = sourceTripRes.data.name || '';
          reusableDays = plansRes.data || [];
          tripData.copiedFromTripId = sourceTripId;
        } else if (templateId) {
          await ensureCollection('trip_templates');
          const { data: template } = await db.collection('trip_templates').doc(templateId).get();
          if (!template || template.ownerId !== OPENID) throw new Error('模板不存在');
          sourceName = template.name || '';
          reusableDays = template.planDays || [];
          tripData.templateId = templateId;
        } else {
          throw new Error('请选择历史行程或模板');
        }

        const now = new Date().toISOString();
        tripData.creatorId = OPENID;
        tripData.status = 'active';
        tripData.createdAt = now;
        const tripRes = await db.collection('trips').add({ data: tripData });
        const tripId = tripRes._id;
        const inviteCode = genInviteCode();
        const user = await getUserByIdentity(OPENID);
        await db.collection('trip_members').add({
          data: {
            tripId,
            openid: OPENID,
            nickName: (user && user.nickName) || '我',
            avatarUrl: (user && user.avatarUrl) || '',
            role: 'creator',
            inviteCode
          }
        });

        const daysToCreate = reusableDays
          .filter(day => Number(day.dayIndex) >= 1 && Number(day.dayIndex) <= tripData.totalDays)
          .slice(0, 60);
        await Promise.all(daysToCreate.map(day => {
          const dayIndex = Number(day.dayIndex) || 1;
          return db.collection('day_plans').add({
            data: {
              tripId,
              dayIndex,
              date: addDaysToDate(tripData.startDate, dayIndex - 1),
              items: sanitizeReusablePlanItems(day.items, `copy_${tripId}_${dayIndex}`),
              createdBy: OPENID,
              copiedFrom: sourceTripId || templateId,
              createdAt: now
            }
          });
        }));
        if (user && !user.currentTripId) {
          await db.collection('users').doc(user._id).update({ data: { currentTripId: tripId, updatedAt: now } });
        }
        return { success: true, tripId, inviteCode, sourceName, copiedPlanDays: daysToCreate.length };
      } catch (error) {
        return { success: false, error: error.message || '复制行程失败' };
      }
    }

    case 'updateTrip': {
      const { tripId, trip } = payload;
      try {
        await requireTripCreator(tripId);
        const tripData = normalizeTripData(trip || {});
        await db.collection('trips').doc(tripId).update({ data: tripData });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'joinTrip': {
      const code = String(payload.code || '').trim().toUpperCase();
      if (code.length < 4) return { success: false, error: '请输入有效邀请码' };
      try {
        const { data: inviteMembers } = await db.collection('trip_members')
          .where({ inviteCode: code })
          .limit(1)
          .get();
        if (!inviteMembers.length) return { success: false, error: '邀请码无效' };

        const tripId = inviteMembers[0].tripId;
        const { data: existing } = await db.collection('trip_members')
          .where({ tripId, openid: OPENID })
          .get();
        if (existing.length) return { success: true, tripId, alreadyJoined: true };

        const { data: trip } = await db.collection('trips').doc(tripId).get();
        if (!trip) return { success: false, error: '行程不存在' };
        if (trip.status === 'archived') return { success: false, error: '行程已归档，无法加入' };

        let nickName = '新成员';
        let avatarUrl = '';
        try {
          const user = await getUserByIdentity(OPENID);
          if (user) {
            nickName = user.nickName || nickName;
            avatarUrl = user.avatarUrl || '';
          }
        } catch (_) {}

        await db.collection('trip_members').add({
          data: {
            tripId,
            openid: OPENID,
            nickName,
            avatarUrl,
            role: 'member',
            inviteCode: ''
          }
        });
        return { success: true, tripId, alreadyJoined: false };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'setTripStatus': {
      const { tripId, status } = payload;
      if (!['active', 'archived'].includes(status)) {
        return { success: false, error: '无效状态' };
      }
      try {
        await requireTripCreator(tripId);
        await db.collection('trips').doc(tripId).update({
          data: { status, updatedAt: new Date().toISOString() }
        });
        if (status === 'archived') {
          const user = await getUserByIdentity(OPENID);
          if (user && user.currentTripId === tripId) {
            await db.collection('users').doc(user._id).update({
              data: { currentTripId: '', updatedAt: new Date().toISOString() }
            });
          }
        }
        return { success: true, status };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'deleteTrip': {
      const { tripId } = payload;
      try {
        await deleteTripWithAuth(tripId);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'deleteTrips': {
      const { tripIds } = payload;
      if (!tripIds || !tripIds.length) return { success: false, error: '缺少 tripIds' };
      try {
        const uniqTripIds = [...new Set(tripIds)].filter(Boolean);
        for (const tripId of uniqTripIds) {
          await deleteTripWithAuth(tripId);
        }
        return { success: true, deleted: uniqTripIds.length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'leaveTrip': {
      const tripId = payload && payload.tripId;
      if (!tripId) return { success: false, error: '缺少 tripId' };
      try {
        await ensureCollection('trip_members');
        const { data: members } = await db.collection('trip_members')
          .where({ tripId, openid: OPENID }).limit(1).get();
        if (!members.length) return { success: false, error: '你不是该行程的成员' };
        const member = members[0];
        if (member.role === 'owner') {
          return { success: false, error: '创建者不能退出，请直接删除行程' };
        }
        await db.collection('trip_members').doc(member._id).remove();
        // 清除当前行程（如果正在退出的行程是当前行程）
        const user = await getUserByIdentity(OPENID);
        if (user && user.currentTripId === tripId) {
          await db.collection('users').doc(user._id).update({
            data: { currentTripId: '', updatedAt: new Date().toISOString() }
          });
        }
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message || '退出行程失败' };
      }
    }

    case 'removeTripMember': {
      const { memberId } = payload;
      if (!memberId) return { success: false, error: '缺少 memberId' };
      try {
        const { data: member } = await db.collection('trip_members').doc(memberId).get();
        if (!member) return { success: false, error: '成员不存在' };
        await requireTripCreator(member.tripId);
        if (member.openid === OPENID || member.role === 'creator' || member.role === 'owner') {
          return { success: false, error: '不能移除创建者' };
        }
        await db.collection('trip_members').doc(memberId).remove();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getPrivateMessages': {
      const { targetOpenid } = payload;
      if (!targetOpenid || targetOpenid === OPENID) {
        return { success: false, error: '缺少私信对象' };
      }
      try {
        await touchUserActive(OPENID);
        const conversationId = privateConversationId(OPENID, targetOpenid);
        let data = [];
        try {
          const res = await db.collection('private_messages')
            .where({ conversationId })
            .orderBy('createdAt', 'asc')
            .limit(100)
            .get();
          data = res.data || [];
        } catch (e) {
          if (!isCollectionNotFound(e)) throw e;
        }
        data = data.filter(message => !((message.hiddenFor || []).includes(OPENID)));
        const targetUser = await getUserByIdentity(targetOpenid);
        const targetPrivacy = (targetUser && targetUser.privacySettings) || {};
        const hiddenForViewer = (targetUser && targetUser.hiddenReadReceiptOpenids) || [];
        const visibleForViewer = (targetUser && targetUser.visibleReadReceiptOpenids) || [];
        const hideTargetReceipts = visibleForViewer.includes(OPENID)
          ? false
          : hiddenForViewer.includes(OPENID) || targetPrivacy.hideReadReceipts === true;
        if (hideTargetReceipts) {
          data.forEach(message => {
            if (message.from === OPENID && message.to === targetOpenid) message.readAt = '';
          });
        }
        const targetLastActiveAt = await getUserLastActiveAt(targetOpenid);
        return { success: true, messages: data, targetLastActiveAt, serverNow: new Date().toISOString() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getUnreadSummary': {
      try {
        const [msgCount, reqCount, notifCount, membershipsRes] = await Promise.all([
          db.collection('private_messages')
            .where({ to: OPENID, readAt: _.exists(false) })
            .count()
            .then(r => r.total || 0)
            .catch(e => isCollectionNotFound(e) ? 0 : Promise.reject(e)),
          db.collection('friend_requests')
            .where({ to: OPENID, status: 'pending' })
            .count()
            .then(r => r.total || 0)
            .catch(e => isCollectionNotFound(e) ? 0 : Promise.reject(e)),
          db.collection('notifications')
            .where({ to: OPENID, read: false })
            .count()
            .then(r => r.total || 0)
            .catch(e => isCollectionNotFound(e) ? 0 : Promise.reject(e)),
          db.collection('group_members')
            .where({ openid: OPENID })
            .limit(100)
            .get()
            .catch(e => isCollectionNotFound(e) ? { data: [] } : Promise.reject(e))
        ]);
        const memberships = membershipsRes.data || [];
        let unreadGroupMessages = 0;
        if (memberships.length) {
          const groupIds = memberships.map(item => item.groupId).filter(Boolean);
          const lastReadMap = {};
          memberships.forEach(item => {
            lastReadMap[item.groupId] = item.lastReadAt || item.joinedAt || '';
          });
          for (let i = 0; i < groupIds.length; i += 20) {
            const ids = groupIds.slice(i, i + 20);
            const { data: messages } = await db.collection('group_messages')
              .where({ groupId: _.in(ids) })
              .limit(1000)
              .get()
              .catch(e => isCollectionNotFound(e) ? { data: [] } : Promise.reject(e));
            unreadGroupMessages += (messages || []).filter(message =>
              message.from !== OPENID && String(message.createdAt || '') > String(lastReadMap[message.groupId] || '')
            ).length;
          }
        }
        return {
          success: true,
          unreadMessages: msgCount,
          unreadGroupMessages,
          pendingFriendRequests: reqCount,
          unreadNotifications: notifCount
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getLatestInboxEvents': {
      const after = String(payload && payload.after || '');
      const serverNow = new Date().toISOString();
      if (!after) return { success: true, events: [], serverNow };
      try {
        const events = [];
        const privateResult = await db.collection('private_messages')
          .where({ to: OPENID, createdAt: _.gt(after) })
          .orderBy('createdAt', 'asc')
          .limit(20)
          .get()
          .catch(e => isCollectionNotFound(e) ? { data: [] } : Promise.reject(e));
        (privateResult.data || []).forEach(message => {
          events.push({
            id: message._id,
            kind: 'private',
            fromOpenid: message.from,
            previewText: messagePreview(message),
            createdAt: message.createdAt || ''
          });
        });

        const membershipsResult = await db.collection('group_members')
          .where({ openid: OPENID })
          .limit(100)
          .get()
          .catch(e => isCollectionNotFound(e) ? { data: [] } : Promise.reject(e));
        const memberships = (membershipsResult.data || []).filter(item => item.notificationsMuted !== true);
        const groupIds = memberships.map(item => item.groupId).filter(Boolean);
        const groups = [];
        for (let i = 0; i < groupIds.length; i += 20) {
          const result = await db.collection('group_chats').where({ _id: _.in(groupIds.slice(i, i + 20)) }).limit(20).get();
          groups.push(...(result.data || []));
        }
        const changedGroups = groups.filter(group => String(group.lastMessageAt || '') > after);
        for (const group of changedGroups.slice(0, 10)) {
          const result = await db.collection('group_messages')
            .where({ groupId: group._id, createdAt: _.gt(after) })
            .orderBy('createdAt', 'asc')
            .limit(10)
            .get();
          (result.data || []).forEach(message => {
            if (message.from === OPENID) return;
            events.push({
              id: message._id,
              kind: 'group',
              groupId: group._id,
              groupName: group.name || '群聊',
              fromOpenid: message.from,
              previewText: messagePreview(message),
              createdAt: message.createdAt || ''
            });
          });
        }

        const userMap = await getUsersByOpenids([...new Set(events.map(item => item.fromOpenid).filter(Boolean))]);
        events.forEach(event => {
          const sender = userMap[event.fromOpenid] || {};
          event.fromNickName = sender.nickName || (event.kind === 'group' ? '群成员' : '新消息');
          event.fromAvatarUrl = sender.avatarUrl || '';
          event.title = event.kind === 'group' ? event.groupName : event.fromNickName;
          if (event.kind === 'group') event.previewText = `${event.fromNickName}：${event.previewText}`;
        });
        const avatarIds = [...new Set(events.map(item => item.fromAvatarUrl).filter(url => typeof url === 'string' && url.startsWith('cloud://')))];
        if (avatarIds.length) {
          const tempResult = await cloud.getTempFileURL({ fileList: avatarIds });
          const tempMap = {};
          (tempResult.fileList || []).forEach(item => { if (item.tempFileURL) tempMap[item.fileID] = item.tempFileURL; });
          events.forEach(event => { if (tempMap[event.fromAvatarUrl]) event.fromAvatarUrl = tempMap[event.fromAvatarUrl]; });
        }
        events.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return { success: true, events: events.slice(-20), serverNow };
      } catch (e) {
        return { success: false, error: e.message, events: [], serverNow };
      }
    }

    case 'pollPrivateChat': {
      const { targetOpenid, lastMessageCreatedAt, unreadMessageIds } = payload;
      if (!targetOpenid || targetOpenid === OPENID) {
        return { success: false, error: '缺少私信对象' };
      }
      try {
        const conversationId = privateConversationId(OPENID, targetOpenid);

        // 1. 拉取新消息，并标记发给当前用户的消息为已读（用户正在看会话）
        let newMessages = [];
        try {
          const res = await db.collection('private_messages')
            .where({ conversationId, createdAt: _.gt(lastMessageCreatedAt || '') })
            .orderBy('createdAt', 'asc')
            .limit(100)
            .get();
          newMessages = (res.data || []).filter(m => !(m.hiddenFor || []).includes(OPENID));
        } catch (e) {
          if (!isCollectionNotFound(e)) throw e;
        }

        // 2. 检查已发送消息的已读状态
        const targetUserRecord = await getUserByIdentity(targetOpenid);
        const targetPrivacy = (targetUserRecord && targetUserRecord.privacySettings) || {};
        const hiddenForViewer = (targetUserRecord && targetUserRecord.hiddenReadReceiptOpenids) || [];
        const visibleForViewer = (targetUserRecord && targetUserRecord.visibleReadReceiptOpenids) || [];
        const hideTargetReceipts = visibleForViewer.includes(OPENID)
          ? false
          : hiddenForViewer.includes(OPENID) || targetPrivacy.hideReadReceipts === true;
        let readMessageIds = [];
        if (!hideTargetReceipts && unreadMessageIds && unreadMessageIds.length > 0) {
          try {
            const res = await db.collection('private_messages')
              .where({ _id: _.in(unreadMessageIds), readAt: _.exists(true) })
              .field({ _id: true })
              .get();
            readMessageIds = (res.data || []).map(m => m._id);
          } catch (e) {
            if (!isCollectionNotFound(e)) throw e;
          }
        }

        // 3. 对方在线状态 & 正在输入 & 心情
        const targetLastActiveAt = await getUserLastActiveAt(targetOpenid);
        const targetUser = targetUserRecord || {};
        const TYPING_WINDOW = 6 * 1000; // 6 秒内算正在输入
        const targetIsTyping = targetUser.lastTypingAt &&
          targetUser.typingTarget === OPENID &&
          (Date.now() - targetUser.lastTypingAt) < TYPING_WINDOW;
        let targetMoodExpired = false;
        if (targetUser.moodUpdatedAt) {
          targetMoodExpired = (Date.now() - new Date(targetUser.moodUpdatedAt).getTime()) > 24 * 60 * 60 * 1000;
        }
        const targetMood = targetPrivacy.showMoodStatus !== false && targetUser.moodEmoji && !targetMoodExpired
          ? { emoji: targetUser.moodEmoji, text: targetUser.moodText || '', updatedAt: targetUser.moodUpdatedAt || '' }
          : null;

        return { success: true, newMessages, readMessageIds, targetLastActiveAt, targetIsTyping, targetMood, serverNow: new Date().toISOString() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'touchTyping': {
      const { targetOpenid } = payload;
      if (!targetOpenid || targetOpenid === OPENID) return { success: true };
      try {
        await touchUserActive(OPENID);
        await db.collection('users').where({ _openid: OPENID }).update({
          data: { lastTypingAt: Date.now(), typingTarget: targetOpenid }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'markMessagesRead': {
      const { messageIds } = payload;
      if (!messageIds || !messageIds.length) return { success: true, marked: 0 };
      try {
        const readAt = new Date().toISOString();
        const res = await db.collection('private_messages')
          .where({ _id: _.in(messageIds), to: OPENID })
          .get();
        // 过滤出真正未读的（readAt 为空字符串或不存在）
        const idsToMark = (res.data || []).filter(m => !m.readAt).map(m => m._id);
        if (idsToMark.length > 0) {
          await Promise.all(idsToMark.map(id =>
            db.collection('private_messages').doc(id).update({ data: { readAt } })
          ));
        }
        return { success: true, marked: idsToMark.length, readAt };
      } catch (e) {
        if (isCollectionNotFound(e)) return { success: true, marked: 0 };
        return { success: false, error: e.message };
      }
    }

    case 'getPrivateConversations': {
      try {
        await touchUserActive(OPENID);
        let data = [];
        try {
          const [sentRes, receivedRes] = await Promise.all([
            db.collection('private_messages')
              .where({ from: OPENID })
              .orderBy('createdAt', 'desc')
              .limit(100)
              .get(),
            db.collection('private_messages')
              .where({ to: OPENID })
              .orderBy('createdAt', 'desc')
              .limit(100)
              .get()
          ]);
          data = [...(sentRes.data || []), ...(receivedRes.data || [])]
            .filter(message => !((message.hiddenFor || []).includes(OPENID)));
        } catch (e) {
          if (!isCollectionNotFound(e)) throw e;
        }

        const byConversation = {};
        data.forEach(message => {
          if (!message.conversationId) return;
          const targetOpenid = message.from === OPENID ? message.to : message.from;
          if (!targetOpenid) return;
          const current = byConversation[message.conversationId];
          if (!current || String(message.createdAt || '') > String(current.lastTime || '')) {
            byConversation[message.conversationId] = {
              conversationId: message.conversationId,
              targetOpenid,
              lastText: messagePreview(message),
              lastTime: message.createdAt || '',
              unread: 0
            };
          }
        });

        data.forEach(message => {
          if (message.to !== OPENID || message.readAt) return;
          const conversation = byConversation[message.conversationId];
          if (conversation) conversation.unread += 1;
        });

        const conversations = Object.values(byConversation)
          .sort((a, b) => String(b.lastTime || '').localeCompare(String(a.lastTime || '')));
        const userMap = await getUsersByOpenids(conversations.map(item => item.targetOpenid));
        conversations.forEach(item => {
          const user = userMap[item.targetOpenid] || {};
          item.nickName = user.nickName || '未设置';
          item.avatarUrl = user.avatarUrl || '';
          item.lastActiveAt = user.lastActiveAt || '';
        });

        return { success: true, conversations, serverNow: new Date().toISOString() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getInvitableTrips': {
      const { targetOpenid } = payload;
      if (!targetOpenid) return { success: false, error: '缺少邀请对象' };
      try {
        await requireFriend(targetOpenid);
        const { data: memberships } = await db.collection('trip_members')
          .where({ openid: OPENID })
          .limit(100)
          .get();
        if (!memberships.length) return { success: true, trips: [] };
        const tripIds = [...new Set(memberships.map(item => item.tripId).filter(Boolean))];
        const [tripsRes, targetMemberships] = await Promise.all([
          db.collection('trips').where({ _id: _.in(tripIds) }).limit(100).get(),
          db.collection('trip_members').where({ openid: targetOpenid, tripId: _.in(tripIds) }).limit(100).get()
        ]);
        const joined = new Set((targetMemberships.data || []).map(item => item.tripId));
        const trips = (tripsRes.data || [])
          .filter(trip => trip.status !== 'archived' && !joined.has(trip._id))
          .map(trip => ({
            _id: trip._id,
            name: trip.name || '未命名行程',
            city: trip.city || '',
            startDate: trip.startDate || '',
            endDate: trip.endDate || ''
          }));
        return { success: true, trips };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'sendTripInvitation': {
      const { targetOpenid, tripId } = payload;
      if (!targetOpenid || !tripId) return { success: false, error: '缺少邀请信息' };
      try {
        await requireFriend(targetOpenid);
        const [{ data: membership }, { data: trip }, existingMember] = await Promise.all([
          db.collection('trip_members').where({ tripId, openid: OPENID }).limit(1).get(),
          db.collection('trips').doc(tripId).get(),
          db.collection('trip_members').where({ tripId, openid: targetOpenid }).limit(1).get()
        ]);
        if (!membership.length) return { success: false, error: '你还不是该行程成员' };
        if (!trip || trip.status === 'archived') return { success: false, error: '行程不可邀请' };
        if ((existingMember.data || []).length) return { success: false, error: '对方已在该行程中' };
        await ensureCollection('private_messages');
        const pendingRes = await db.collection('private_messages').where({
          from: OPENID,
          to: targetOpenid,
          type: 'trip_invite',
          tripId,
          invitationStatus: 'pending'
        }).limit(1).get();
        if ((pendingRes.data || []).length) {
          return { success: true, message: pendingRes.data[0], alreadySent: true };
        }
        const message = {
          conversationId: privateConversationId(OPENID, targetOpenid),
          from: OPENID,
          to: targetOpenid,
          type: 'trip_invite',
          text: `邀请你加入行程：${trip.name || '未命名行程'}`,
          tripId,
          tripName: trip.name || '未命名行程',
          tripCity: trip.city || '',
          tripStartDate: trip.startDate || '',
          tripEndDate: trip.endDate || '',
          invitationStatus: 'pending',
          createdAt: new Date().toISOString()
        };
        const res = await db.collection('private_messages').add({ data: message });
        return { success: true, message: { ...message, _id: res._id }, alreadySent: false };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'respondTripInvitation': {
      const { messageId, accept } = payload;
      if (!messageId) return { success: false, error: '缺少行程邀请' };
      try {
        const { data: message } = await db.collection('private_messages').doc(messageId).get();
        if (!message || message.type !== 'trip_invite' || message.to !== OPENID || message.invitationStatus !== 'pending') {
          return { success: false, error: '行程邀请已失效' };
        }
        if (!accept) {
          await db.collection('private_messages').doc(messageId).update({
            data: { invitationStatus: 'rejected', respondedAt: new Date().toISOString() }
          });
          return { success: true, status: 'rejected', tripId: message.tripId };
        }
        const { data: trip } = await db.collection('trips').doc(message.tripId).get();
        if (!trip || trip.status === 'archived') return { success: false, error: '行程已失效' };
        const { data: existing } = await db.collection('trip_members')
          .where({ tripId: message.tripId, openid: OPENID })
          .limit(1)
          .get();
        if (!existing.length) {
          const user = await getUserByIdentity(OPENID);
          await db.collection('trip_members').add({
            data: {
              tripId: message.tripId,
              openid: OPENID,
              nickName: (user && user.nickName) || '新成员',
              avatarUrl: (user && user.avatarUrl) || '',
              role: 'member',
              inviteCode: ''
            }
          });
        }
        await db.collection('private_messages').doc(messageId).update({
          data: { invitationStatus: 'accepted', respondedAt: new Date().toISOString() }
        });
        return { success: true, status: 'accepted', tripId: message.tripId };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'sendRichPrivateMessage': {
      const { targetOpenid, type, data = {} } = payload;
      if (!['image', 'voice', 'location', 'file', 'user_card', 'moment_share'].includes(type)) {
        return { success: false, error: '不支持的消息类型' };
      }
      try {
        await checkPrivateMessageLimit(targetOpenid);
        const messageData = { type };
        if (type === 'image') {
          if (!data.fileId) return { success: false, error: '缺少图片' };
          messageData.imageFileId = String(data.fileId);
          messageData.text = '[图片]';
        } else if (type === 'voice') {
          if (!data.fileId) return { success: false, error: '缺少语音文件' };
          messageData.voiceFileId = String(data.fileId);
          messageData.voiceDuration = Math.min(60, Math.max(1, Math.round(Number(data.duration) || 1)));
          messageData.text = `[语音] ${messageData.voiceDuration}秒`;
        } else if (type === 'location') {
          const latitude = Number(data.latitude);
          const longitude = Number(data.longitude);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { success: false, error: '位置信息无效' };
          messageData.latitude = latitude;
          messageData.longitude = longitude;
          messageData.locationName = String(data.name || data.address || '位置').slice(0, 80);
          messageData.locationAddress = String(data.address || '').slice(0, 120);
          messageData.text = `[位置] ${messageData.locationName}`;
        } else if (type === 'file') {
          if (!data.fileId) return { success: false, error: '缺少文件' };
          const rawName = String(data.fileName || '文件').trim();
          const extension = String(data.fileType || (rawName.includes('.') ? rawName.split('.').pop() : '')).toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(extension)) {
            return { success: false, error: '仅支持 Word、Excel、PPT 和 PDF 文件' };
          }
          const suffix = `.${extension}`;
          const baseName = rawName.toLowerCase().endsWith(suffix) ? rawName.slice(0, -suffix.length) : rawName;
          const fileName = `${baseName.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
          messageData.fileId = String(data.fileId);
          messageData.fileName = fileName;
          messageData.fileType = extension;
          messageData.fileSize = Math.max(0, Number(data.fileSize) || 0);
          messageData.text = `[文件] ${messageData.fileName}`;
        } else if (type === 'user_card') {
          const cardOpenid = String(data.openid || '');
          const cardUser = await getUserByIdentity(cardOpenid);
          if (!cardUser) return { success: false, error: '名片用户不存在' };
          messageData.cardOpenid = cardOpenid;
          messageData.cardName = cardUser.nickName || '未设置';
          messageData.cardAvatar = cardUser.avatarUrl || '';
          messageData.cardPublicId = cardUser.publicId || '';
          messageData.text = `[名片] ${messageData.cardName}`;
        } else if (type === 'moment_share') {
          const momentId = String(data.momentId || '');
          const { data: moment } = await db.collection('moments').doc(momentId).get();
          if (!moment || moment.isPrivate === true) return { success: false, error: '动态不可分享' };
          messageData.momentId = momentId;
          messageData.momentAuthorId = moment.authorId || '';
          messageData.momentAuthorName = moment.authorName || '旅友';
          messageData.momentText = String(moment.text || '').slice(0, 100);
          messageData.momentImage = Array.isArray(moment.images) && moment.images.length ? moment.images[0] : '';
          messageData.text = '[动态分享]';
        }
        const quoteData = await buildPrivateQuote(data.quoteMessageId, targetOpenid);
        const message = await addPrivateMessage(targetOpenid, { ...messageData, ...quoteData });
        return { success: true, message };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'sendPrivateMessage': {
      const { targetOpenid, text, quoteMessageId } = payload;
      const content = String(text || '').trim();
      if (!targetOpenid || targetOpenid === OPENID) {
        return { success: false, error: '缺少私信对象' };
      }
      if (!content) return { success: false, error: '消息不能为空' };
      if (content.length > 500) return { success: false, error: '消息太长' };
      try {
        await checkPrivateMessageLimit(targetOpenid);
        const quoteData = await buildPrivateQuote(quoteMessageId, targetOpenid);
        const message = await addPrivateMessage(targetOpenid, { type: 'text', text: content, ...quoteData });
        return { success: true, message };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'recallPrivateMessage': {
      const { messageId } = payload;
      try {
        const message = await getPrivateMessageWithAccess(messageId);
        if (message.from !== OPENID) return { success: false, error: '只能撤回自己发送的消息' };
        if (message.type === 'revoked') return { success: true, revokedAt: message.revokedAt || '' };
        const createdAt = new Date(message.createdAt).getTime();
        if (!createdAt || Date.now() - createdAt > 2 * 60 * 1000) {
          return { success: false, error: '消息发送超过两分钟，无法撤回' };
        }
        const revokedAt = new Date().toISOString();
        await db.collection('private_messages').doc(messageId).update({
          data: {
            type: 'revoked',
            text: '',
            imageFileId: '',
            fileId: '',
            locationName: '',
            locationAddress: '',
            cardOpenid: '',
            momentId: '',
            revokedAt,
            revokedBy: OPENID
          }
        });
        return { success: true, revokedAt };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'hidePrivateMessage': {
      const { messageId } = payload;
      try {
        const message = await getPrivateMessageWithAccess(messageId);
        const hiddenFor = [...new Set([...(message.hiddenFor || []), OPENID])];
        await db.collection('private_messages').doc(messageId).update({ data: { hiddenFor } });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'createGroupChat': {
      const name = String(payload.name || '').trim().slice(0, 30);
      const memberOpenids = [...new Set((payload.memberOpenids || []).filter(id => id && id !== OPENID))].slice(0, 49);
      if (!name) return { success: false, error: '请输入群聊名称' };
      if (!memberOpenids.length) return { success: false, error: '至少选择一位好友' };
      try {
        for (const openid of memberOpenids) await requireFriend(openid);
        await Promise.all(['group_chats', 'group_members', 'group_messages'].map(ensureCollection));
        const now = new Date().toISOString();
        const groupRes = await db.collection('group_chats').add({
          data: { name, owner: OPENID, createdAt: now, updatedAt: now, lastMessage: '群聊已创建', lastMessageAt: now }
        });
        const groupId = groupRes._id;
        await Promise.all([OPENID, ...memberOpenids].map(openid => db.collection('group_members').add({
          data: { groupId, openid, role: openid === OPENID ? 'owner' : 'member', joinedAt: now, lastReadAt: now }
        })));
        return { success: true, groupId };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getGroupConversations': {
      try {
        await Promise.all(['group_chats', 'group_members', 'group_messages'].map(ensureCollection));
        const { data: memberships } = await db.collection('group_members').where({ openid: OPENID }).limit(100).get();
        if (!memberships.length) return { success: true, groups: [] };
        const groupIds = memberships.map(item => item.groupId);
        const { data: groups } = await db.collection('group_chats').where({ _id: _.in(groupIds) }).limit(100).get();
        const membershipMap = {};
        memberships.forEach(item => { membershipMap[item.groupId] = item; });
        const result = [];
        for (const group of groups) {
          const membership = membershipMap[group._id] || {};
          const unread = await db.collection('group_messages').where({
            groupId: group._id,
            createdAt: _.gt(membership.lastReadAt || membership.joinedAt || '')
          }).count();
          result.push({
            ...group,
            unread: unread.total || 0,
            myNotificationsMuted: membership.notificationsMuted === true
          });
        }
        result.sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
        return { success: true, groups: result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getGroupMessages': {
      const { groupId, since } = payload;
      try {
        const membership = await requireGroupMember(groupId);
        const whereClause = since ? { groupId, createdAt: _.gt(since) } : { groupId };
        const [{ data: group }, messagesRes, membersRes] = await Promise.all([
          db.collection('group_chats').doc(groupId).get(),
          db.collection('group_messages').where(whereClause).orderBy('createdAt', 'asc').limit(100).get(),
          db.collection('group_members').where({ groupId }).limit(100).get()
        ]);
        const messages = (messagesRes.data || []).filter(m => !(m.hiddenFor || []).includes(OPENID));
        if (messages.length > 0) {
          const memberOpenids = (membersRes.data || []).map(item => item.openid);
          const userMap = await getUsersByOpenids(memberOpenids);
          messages.forEach(message => {
            const user = userMap[message.from] || {};
            message.senderName = user.nickName || '群成员';
            message.senderAvatar = user.avatarUrl || '';
          });
        }
        await db.collection('group_members').doc(membership._id).update({ data: { lastReadAt: new Date().toISOString() } });
        const members = (membersRes.data || []);
        return {
          success: true, group, messages, members,
          myRole: membership.role || 'member',
          myMuted: !!membership.muted,
          myNotificationsMuted: !!membership.notificationsMuted
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'sendGroupMessage': {
      const { groupId, quoteMessageId } = payload;
      const text = String(payload.text || '').trim();
      if (!text) return { success: false, error: '消息不能为空' };
      if (text.length > 500) return { success: false, error: '消息太长' };
      try {
        const membership = await requireGroupMember(groupId);
        if (membership.muted) return { success: false, error: '你已被禁言' };
        const now = new Date().toISOString();
        const quoteData = await buildGroupQuote(quoteMessageId, groupId);
        const message = { groupId, from: OPENID, type: 'text', text, createdAt: now, ...quoteData };
        const res = await db.collection('group_messages').add({ data: message });
        const lastPreview = quoteData.quoteText ? `[引用] ${text}` : text;
        await db.collection('group_chats').doc(groupId).update({ data: { lastMessage: lastPreview.slice(0, 100), lastMessageAt: now, updatedAt: now } });
        const user = await getUserByIdentity(OPENID);
        return {
          success: true,
          message: {
            ...message,
            _id: res._id,
            senderName: (user && user.nickName) || '我',
            senderAvatar: (user && user.avatarUrl) || ''
          }
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'sendRichGroupMessage': {
      const { groupId, type, data = {} } = payload;
      if (!['image', 'voice', 'location', 'file', 'user_card', 'moment_share'].includes(type)) {
        return { success: false, error: '不支持的消息类型' };
      }
      try {
        const membership = await requireGroupMember(groupId);
        if (membership.muted) return { success: false, error: '你已被禁言' };
        const messageData = { type };
        if (type === 'image') {
          if (!data.fileId) return { success: false, error: '缺少图片' };
          messageData.imageFileId = String(data.fileId);
          messageData.text = '[图片]';
        } else if (type === 'voice') {
          if (!data.fileId) return { success: false, error: '缺少语音文件' };
          messageData.voiceFileId = String(data.fileId);
          messageData.voiceDuration = Math.min(60, Math.max(1, Math.round(Number(data.duration) || 1)));
          messageData.text = `[语音] ${messageData.voiceDuration}秒`;
        } else if (type === 'location') {
          const latitude = Number(data.latitude);
          const longitude = Number(data.longitude);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { success: false, error: '位置信息无效' };
          messageData.latitude = latitude;
          messageData.longitude = longitude;
          messageData.locationName = String(data.name || data.address || '位置').slice(0, 80);
          messageData.locationAddress = String(data.address || '').slice(0, 120);
          messageData.text = `[位置] ${messageData.locationName}`;
        } else if (type === 'file') {
          if (!data.fileId) return { success: false, error: '缺少文件' };
          const rawName = String(data.fileName || '文件').trim();
          const extension = String(data.fileType || (rawName.includes('.') ? rawName.split('.').pop() : '')).toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(extension)) {
            return { success: false, error: '仅支持 Word、Excel、PPT 和 PDF 文件' };
          }
          const suffix = `.${extension}`;
          const baseName = rawName.toLowerCase().endsWith(suffix) ? rawName.slice(0, -suffix.length) : rawName;
          const fileName = `${baseName.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
          messageData.fileId = String(data.fileId);
          messageData.fileName = fileName;
          messageData.fileType = extension;
          messageData.fileSize = Math.max(0, Number(data.fileSize) || 0);
          messageData.text = `[文件] ${messageData.fileName}`;
        } else if (type === 'user_card') {
          const cardOpenid = String(data.openid || '');
          const cardUser = await getUserByIdentity(cardOpenid);
          if (!cardUser) return { success: false, error: '名片用户不存在' };
          messageData.cardOpenid = cardOpenid;
          messageData.cardName = cardUser.nickName || '未设置';
          messageData.cardAvatar = cardUser.avatarUrl || '';
          messageData.cardPublicId = cardUser.publicId || '';
          messageData.text = `[名片] ${messageData.cardName}`;
        } else if (type === 'moment_share') {
          const momentId = String(data.momentId || '');
          const { data: moment } = await db.collection('moments').doc(momentId).get();
          if (!moment || moment.isPrivate === true) return { success: false, error: '动态不可分享' };
          messageData.momentId = momentId;
          messageData.momentAuthorId = moment.authorId || '';
          messageData.momentAuthorName = moment.authorName || '旅友';
          messageData.momentText = String(moment.text || '').slice(0, 100);
          messageData.momentImage = Array.isArray(moment.images) && moment.images.length ? moment.images[0] : '';
          messageData.text = '[动态分享]';
        }
        const quoteData = await buildGroupQuote(data.quoteMessageId, groupId);
        const now = new Date().toISOString();
        const message = { groupId, from: OPENID, createdAt: now, ...messageData, ...quoteData };
        const res = await db.collection('group_messages').add({ data: message });
        await db.collection('group_chats').doc(groupId).update({ data: { lastMessage: messageData.text, lastMessageAt: now, updatedAt: now } });
        const user = await getUserByIdentity(OPENID);
        return {
          success: true,
          message: {
            ...message,
            _id: res._id,
            senderName: (user && user.nickName) || '我',
            senderAvatar: (user && user.avatarUrl) || ''
          }
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'recallGroupMessage': {
      const { messageId } = payload;
      try {
        const { data: message } = await db.collection('group_messages').doc(messageId).get();
        if (!message) return { success: false, error: '消息不存在' };
        if (message.from !== OPENID) return { success: false, error: '只能撤回自己发送的消息' };
        await requireGroupMember(message.groupId);
        if (message.type === 'revoked') return { success: true, revokedAt: message.revokedAt || '' };
        const createdAt = new Date(message.createdAt).getTime();
        if (!createdAt || Date.now() - createdAt > 2 * 60 * 1000) {
          return { success: false, error: '消息发送超过两分钟，无法撤回' };
        }
        const revokedAt = new Date().toISOString();
        await db.collection('group_messages').doc(messageId).update({
          data: {
            type: 'revoked',
            text: '',
            imageFileId: '',
            fileId: '',
            locationName: '',
            locationAddress: '',
            cardOpenid: '',
            momentId: '',
            revokedAt,
            revokedBy: OPENID
          }
        });
        return { success: true, revokedAt };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'hideGroupMessage': {
      const { messageId } = payload;
      try {
        const { data: message } = await db.collection('group_messages').doc(messageId).get();
        if (!message) return { success: false, error: '消息不存在' };
        const hiddenFor = [...new Set([...(message.hiddenFor || []), OPENID])];
        await db.collection('group_messages').doc(messageId).update({ data: { hiddenFor } });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'leaveGroup': {
      const { groupId } = payload;
      try {
        const membership = await requireGroupMember(groupId);
        // 群主不能直接退出（除非只有自己一人）
        if (membership.role === 'owner') {
          const { total } = await db.collection('group_members').where({ groupId }).count();
          if (total > 1) return { success: false, error: '群主不能直接退出，请先解散群聊' };
          // 只有自己 → 直接解散
          await removeByTripId('group_members', groupId);
          await removeByTripId('group_messages', groupId);
          await db.collection('group_chats').doc(groupId).remove();
          return { success: true, dissolved: true };
        }
        await db.collection('group_members').doc(membership._id).remove();
        return { success: true, dissolved: false };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'toggleGroupNotifications': {
      const { groupId } = payload;
      try {
        const membership = await requireGroupMember(groupId);
        const newVal = !membership.notificationsMuted;
        await db.collection('group_members').doc(membership._id).update({ data: { notificationsMuted: newVal } });
        return { success: true, notificationsMuted: newVal };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'muteGroupMember': {
      const { groupId, memberOpenid } = payload;
      if (!memberOpenid) return { success: false, error: '缺少成员' };
      try {
        const callerMembership = await requireGroupMember(groupId);
        if (callerMembership.role !== 'owner') return { success: false, error: '仅群主可禁言' };
        if (memberOpenid === OPENID) return { success: false, error: '不能禁言自己' };
        const { data: target } = await db.collection('group_members').where({ groupId, openid: memberOpenid }).limit(1).get();
        if (!target.length) return { success: false, error: '成员不在群中' };
        await db.collection('group_members').doc(target[0]._id).update({ data: { muted: true } });
        return { success: true, muted: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'unmuteGroupMember': {
      const { groupId, memberOpenid } = payload;
      if (!memberOpenid) return { success: false, error: '缺少成员' };
      try {
        const callerMembership = await requireGroupMember(groupId);
        if (callerMembership.role !== 'owner') return { success: false, error: '仅群主可解除禁言' };
        const { data: target } = await db.collection('group_members').where({ groupId, openid: memberOpenid }).limit(1).get();
        if (!target.length) return { success: false, error: '成员不在群中' };
        await db.collection('group_members').doc(target[0]._id).update({ data: { muted: false } });
        return { success: true, muted: false };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'dissolveGroup': {
      const { groupId } = payload;
      try {
        const membership = await requireGroupMember(groupId);
        if (membership.role !== 'owner') return { success: false, error: '仅群主可解散群聊' };
        await removeByTripId('group_messages', groupId);
        await removeByTripId('group_members', groupId);
        await db.collection('group_chats').doc(groupId).remove();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // 批量获取云文件临时链接（服务端执行，绕过存储权限限制）
    case 'getTempUrls': {
      const { fileList } = payload;
      if (!fileList || !fileList.length) return { success: true, urls: {} };
      try {
        const res = await cloud.getTempFileURL({ fileList });
        const urls = {};
        res.fileList.forEach(item => {
          if (item.tempFileURL) urls[item.fileID] = item.tempFileURL;
        });
        return { success: true, urls };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ══════ 获取我的行程（memberships + trips） ══════
    case 'getMyTrips': {
      try {
        const { data: memberships } = await db.collection('trip_members')
          .where({ openid: OPENID })
          .get();

        if (!memberships.length) {
          return { success: true, memberships: [], trips: [], currentTripId: '' };
        }

        const tripIds = memberships.map(m => m.tripId);
        const { data: trips } = await db.collection('trips')
          .where({ _id: db.command.in(tripIds) })
          .orderBy('createdAt', 'desc')
          .get();

        const activeTrips = trips.filter(trip => trip.status !== 'archived');
        const allowedIds = new Set(activeTrips.map(trip => trip._id));
        const user = await getUserByIdentity(OPENID);
        let currentTripId = user && allowedIds.has(user.currentTripId) ? user.currentTripId : '';
        if (!currentTripId) {
          const today = new Date().toISOString().slice(0, 10);
          const happening = activeTrips.filter(trip => trip.startDate <= today && trip.endDate >= today);
          if (happening.length === 1) currentTripId = happening[0]._id;
          else if (activeTrips.length === 1) currentTripId = activeTrips[0]._id;
          if (currentTripId && user) {
            await db.collection('users').doc(user._id).update({
              data: { currentTripId, updatedAt: new Date().toISOString() }
            });
          }
        }
        return {
          success: true,
          memberships,
          currentTripId,
          trips: trips.map(trip => ({ ...trip, isCurrent: trip._id === currentTripId }))
        };
      } catch (e) {
        console.error('getMyTrips error:', e);
        return { success: false, error: '获取行程失败' };
      }
    }

    case 'setCurrentTrip': {
      const tripId = String(payload && payload.tripId || '');
      if (!tripId) return { success: false, error: '缺少行程 ID' };
      try {
        await requireTripMembership(tripId);
        const { data: trip } = await db.collection('trips').doc(tripId).get();
        if (!trip || trip.status === 'archived') return { success: false, error: '历史行程不能设为当前行程' };
        const user = await getUserByIdentity(OPENID);
        if (!user) return { success: false, error: '用户资料不存在' };
        await db.collection('users').doc(user._id).update({
          data: { currentTripId: tripId, updatedAt: new Date().toISOString() }
        });
        return { success: true, currentTripId: tripId };
      } catch (error) {
        return { success: false, error: error.message || '设置当前行程失败' };
      }
    }

    case 'getTripSnapshot': {
      const { tripId, include = [] } = payload || {};
      if (!tripId) return { success: false, error: '缺少行程 ID' };
      try {
        await requireTripMembership(tripId);
        const requested = new Set(Array.isArray(include) ? include : []);
        const tasks = {};
        if (requested.has('trip')) tasks.trip = db.collection('trips').doc(tripId).get();
        if (requested.has('members')) tasks.members = db.collection('trip_members').where({ tripId }).get();
        if (requested.has('plans')) tasks.plans = db.collection('day_plans').where({ tripId }).orderBy('dayIndex', 'asc').get();
        if (requested.has('expenses')) tasks.expenses = db.collection('expenses').where({ tripId }).orderBy('createdAt', 'desc').get();
        const keys = Object.keys(tasks);
        const values = await Promise.all(keys.map(key => tasks[key]));
        const result = { success: true };
        keys.forEach((key, index) => {
          const data = values[index] && values[index].data;
          result[key] = key === 'trip' ? (data || null) : (data || []);
        });
        return result;
      } catch (e) {
        return { success: false, error: e.message || '获取行程数据失败' };
      }
    }

    case 'getMomentFeed': {
      const input = payload || {};
      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);
      const offset = Math.max(Number(input.offset) || 0, 0);
      const friendsOnly = input.friendsOnly === true;
      try {
        let where = {};

        if (friendsOnly) {
          await ensureCollection('friend_requests');
          const [fromAccepted, toAccepted] = await Promise.all([
            db.collection('friend_requests').where({ from: OPENID, status: 'accepted' }).limit(500).get(),
            db.collection('friend_requests').where({ to: OPENID, status: 'accepted' }).limit(500).get()
          ]);
          const friendOpenids = new Set();
          (fromAccepted.data || []).forEach(r => friendOpenids.add(r.to));
          (toAccepted.data || []).forEach(r => friendOpenids.add(r.from));
          if (!friendOpenids.size) {
            return { success: true, moments: [], totalRead: 0 };
          }
          where.authorId = _.in([...friendOpenids]);
        } else {
          const { data: memberships } = await db.collection('trip_members').where({ openid: OPENID }).get();
          const allowedTripIds = new Set((memberships || []).map(item => item.tripId));
          let tripIds = Array.isArray(input.tripIds) ? input.tripIds.filter(id => allowedTripIds.has(id)) : [...allowedTripIds];
          if (input.tripId) tripIds = allowedTripIds.has(input.tripId) ? [input.tripId] : [];
          if (!tripIds.length) return { success: true, moments: [], totalRead: 0 };
          where.tripId = _.in(tripIds);
          if (input.authorId) where.authorId = input.authorId;
        }

        const { data } = await db.collection('moments').where(where)
          .orderBy('createdAt', 'desc').skip(offset).limit(limit).get();
        const self = await getUserByIdentity(OPENID);
        const hidden = new Set((self && self.hiddenMomentOpenids) || []);
        const moments = (data || []).filter(item =>
          (!item.isPrivate || item.authorId === OPENID) && !hidden.has(item.authorId)
        );
        return { success: true, moments, totalRead: (data || []).length };
      } catch (e) {
        return { success: false, error: e.message || '获取动态失败' };
      }
    }

    case 'getMomentById': {
      const { momentId } = payload || {};
      if (!momentId) return { success: false, error: '缺少动态 ID' };
      try {
        const { data: moment } = await db.collection('moments').doc(momentId).get();
        if (!moment) throw new Error('动态不存在');
        await requireTripMembership(moment.tripId);
        if (moment.isPrivate && moment.authorId !== OPENID) throw new Error('该动态不可见');
        const self = await getUserByIdentity(OPENID);
        if (((self && self.hiddenMomentOpenids) || []).includes(moment.authorId)) throw new Error('该动态不可见');
        return { success: true, moment };
      } catch (e) {
        return { success: false, error: e.message || '获取动态失败' };
      }
    }

    // ══════ 行程详情（单次请求返回首屏数据） ══════
    case 'getTripDetail': {
      const { tripId } = payload || {};
      if (!tripId) return { success: false, error: '缺少行程 ID' };
      try {
        await requireTripMembership(tripId);
        const [tripRes, membersRes, plansRes] = await Promise.all([
          db.collection('trips').doc(tripId).get(),
          db.collection('trip_members').where({ tripId }).get(),
          db.collection('day_plans').where({ tripId }).orderBy('dayIndex', 'asc').get()
        ]);
        if (!tripRes.data) return { success: false, error: '行程不存在' };
        return {
          success: true,
          trip: tripRes.data,
          members: membersRes.data || [],
          dayPlans: plansRes.data || []
        };
      } catch (e) {
        return { success: false, error: e.message || '获取行程失败' };
      }
    }

    // ══════ 添加支出 ══════
    case 'addExpense': {
      const { expense } = payload || {};
      if (!expense || !expense.tripId) return { success: false, error: '缺少支出信息' };

      try {
        await requireTripWritable(expense.tripId);
        const amount = Number(expense.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
          return { success: false, error: '金额不正确' };
        }
        const { data: tripMembers } = await db.collection('trip_members').where({ tripId: expense.tripId }).get();
        const memberIds = new Set((tripMembers || []).map(member => member.openid));
        if (expense.paidBy && !memberIds.has(expense.paidBy)) {
          return { success: false, error: '付款人不在行程成员中' };
        }
        const category = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORY_LABELS, expense.category)
          ? expense.category : 'other';
        const type = expense.type === 'shared' ? 'shared' : 'private';
        const splitAmong = type === 'shared'
          ? [...new Set((expense.splitAmong || []).filter(openid => memberIds.has(openid)))]
          : [];
        if (type === 'shared' && !splitAmong.length) {
          return { success: false, error: '请选择分摊成员' };
        }
        const data = {
          tripId: expense.tripId,
          type,
          category,
          amount,
          description: String(expense.description || '').trim().slice(0, 100) || '支出',
          paidBy: expense.paidBy || OPENID,
          paidByName: String(expense.paidByName || '').trim().slice(0, 30) || '未知',
          splitAmong,
          receiptFileId: String(expense.receiptFileId || ''),
          voiceFileId: String(expense.voiceFileId || ''),
          voiceDuration: Math.max(0, Number(expense.voiceDuration) || 0),
          createdBy: OPENID,
          createdAt: expense.createdAt || new Date().toISOString()
        };
        await db.collection('expenses').add({ data });
        return { success: true };
      } catch (e) {
        console.error('addExpense error:', e);
        return { success: false, error: e.message || '添加支出失败' };
      }
    }

    // ══════ 更新支出 ══════
    case 'updateExpense': {
      const { expenseId, updates } = payload || {};
      if (!expenseId) return { success: false, error: '缺少支出ID' };
      try {
        const { data: expense } = await db.collection('expenses').doc(expenseId).get();
        if (!expense) return { success: false, error: '支出不存在' };
        if (expense.createdBy !== OPENID) return { success: false, error: '只能编辑自己的支出' };
        if (expense.settled) return { success: false, error: '已结算账单不能编辑' };
        await requireTripWritable(expense.tripId);
        const { data: tripMembers } = await db.collection('trip_members').where({ tripId: expense.tripId }).get();
        const memberIds = new Set((tripMembers || []).map(member => member.openid));
        const allowed = {};
        if (updates.amount !== undefined) {
          const a = Number(updates.amount);
          if (!Number.isFinite(a) || a <= 0 || a > 10000000) return { success: false, error: '金额不正确' };
          allowed.amount = a;
        }
        if (updates.description !== undefined) allowed.description = String(updates.description).trim().slice(0, 100);
        if (updates.category !== undefined) {
          allowed.category = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORY_LABELS, updates.category) ? updates.category : 'other';
        }
        if (updates.type !== undefined) {
          allowed.type = updates.type === 'shared' ? 'shared' : 'private';
        }
        const nextType = allowed.type || expense.type || 'private';
        if (updates.paidBy !== undefined) {
          if (updates.paidBy && !memberIds.has(updates.paidBy)) return { success: false, error: '付款人不在行程成员中' };
          allowed.paidBy = updates.paidBy || OPENID;
        }
        if (updates.paidByName !== undefined) {
          allowed.paidByName = String(updates.paidByName || '').trim().slice(0, 30) || '未知';
        }
        if (updates.splitAmong !== undefined || updates.type !== undefined) {
          const inputSplit = updates.splitAmong !== undefined ? updates.splitAmong : (expense.splitAmong || []);
          const splitAmong = nextType === 'shared'
            ? [...new Set((inputSplit || []).filter(openid => memberIds.has(openid)))]
            : [];
          if (nextType === 'shared' && !splitAmong.length) return { success: false, error: '请选择分摊成员' };
          allowed.splitAmong = splitAmong;
        }
        if (updates.receiptFileId !== undefined) allowed.receiptFileId = String(updates.receiptFileId || '');
        if (updates.voiceFileId !== undefined) allowed.voiceFileId = String(updates.voiceFileId || '');
        if (updates.voiceDuration !== undefined) allowed.voiceDuration = Math.max(0, Number(updates.voiceDuration) || 0);
        if (Object.keys(allowed).length === 0) return { success: false, error: '无有效更新' };
        allowed.updatedAt = new Date().toISOString();
        await db.collection('expenses').doc(expenseId).update({ data: allowed });
        return { success: true };
      } catch (e) {
        console.error('updateExpense error:', e);
        return { success: false, error: e.message || '更新失败' };
      }
    }

    // ══════ 删除支出 ══════
    case 'deleteExpense': {
      const { expenseId } = payload || {};
      if (!expenseId) return { success: false, error: '缺少支出ID' };
      try {
        const { data: expense } = await db.collection('expenses').doc(expenseId).get();
        if (!expense) return { success: false, error: '支出不存在' };
        if (expense.createdBy !== OPENID) return { success: false, error: '只能删除自己的支出' };
        if (expense.settled) return { success: false, error: '已结算账单不能删除' };
        await requireTripWritable(expense.tripId);
        await db.collection('expenses').doc(expenseId).remove();
        return { success: true };
      } catch (e) {
        console.error('deleteExpense error:', e);
        return { success: false, error: e.message || '删除失败' };
      }
    }

    // ══════ 记录结算 ══════
    case 'recordSettlement': {
      const { tripId, settledExpenseIds, transfers } = payload || {};
      if (!tripId || !settledExpenseIds || !settledExpenseIds.length) {
        return { success: false, error: '缺少结算信息' };
      }
      try {
        await requireTripWritable(tripId);
        // 标记支出为已结算
        const batch = settledExpenseIds.map(id => db.collection('expenses').doc(id).update({ data: { settled: true } }));
        await Promise.all(batch);
        // 记录结算历史
        const totalSettled = (transfers || []).reduce((sum, t) => sum + (t.amount || 0), 0);
        await db.collection('settlement_records').add({
          data: {
            tripId,
            settledExpenseIds,
            transfers: transfers || [],
            totalSettled: Math.round(totalSettled * 100) / 100,
            settledBy: OPENID,
            createdAt: new Date().toISOString()
          }
        });
        return { success: true };
      } catch (e) {
        console.error('recordSettlement error:', e);
        return { success: false, error: e.message || '结算失败' };
      }
    }

    // ══════ 获取结算历史 ══════
    case 'getSettlementHistory': {
      const { tripId } = payload || {};
      if (!tripId) return { success: false, error: '缺少行程ID' };
      try {
        const { data: records } = await db.collection('settlement_records')
          .where({ tripId })
          .orderBy('createdAt', 'desc')
          .get();
        return { success: true, records: records || [] };
      } catch (e) {
        console.error('getSettlementHistory error:', e);
        return { success: false, error: e.message || '获取历史失败' };
      }
    }

    // ══════ 添加退款 ══════
    case 'addRefund': {
      const { expenseId, amount, description } = payload || {};
      if (!expenseId || !amount || Number(amount) <= 0) return { success: false, error: '缺少退款信息' };
      try {
        const { data: expense } = await db.collection('expenses').doc(expenseId).get();
        if (!expense) return { success: false, error: '支出不存在' };
        if (expense.settled) return { success: false, error: '已结算账单不能退款' };
        await requireTripWritable(expense.tripId);
        const refundAmount = Number(amount);
        const currentRefunded = expense.refunded || 0;
        if (currentRefunded + refundAmount > expense.amount) {
          return { success: false, error: '退款金额超过原消费金额' };
        }
        const refundEntry = {
          amount: refundAmount,
          description: String(description || '').trim().slice(0, 100) || '退款',
          refunder: OPENID,
          createdAt: new Date().toISOString()
        };
        await db.collection('expenses').doc(expenseId).update({
          data: {
            refunded: Math.round((currentRefunded + refundAmount) * 100) / 100,
            refundHistory: [...(expense.refundHistory || []), refundEntry],
            updatedAt: new Date().toISOString()
          }
        });
        return { success: true };
      } catch (e) {
        console.error('addRefund error:', e);
        return { success: false, error: e.message || '退款失败' };
      }
    }

    // ══════ 新增/更新日行程 ══════
    case 'upsertDayPlan': {
      const { dpId, tripId, dayIndex, date, items } = payload || {};
      if (!tripId || dayIndex == null) return { success: false, error: '缺少参数' };

      try {
        await requireTripWritable(tripId);
        if (dpId) {
          const { data: existingPlan } = await db.collection('day_plans').doc(dpId).get();
          if (!existingPlan || existingPlan.tripId !== tripId) throw new Error('日程不存在');
          await db.collection('day_plans').doc(dpId).update({ data: { items } });
        } else {
          await db.collection('day_plans').add({
            data: { tripId, dayIndex, date, items, createdBy: OPENID }
          });
        }
        return { success: true };
      } catch (e) {
        console.error('upsertDayPlan error:', e);
        return { success: false, error: e.message || '保存失败' };
      }
    }

    // ══════ 删除日行程（或移除单项） ══════
    case 'deleteDayPlanItem': {
      const { dpId, items } = payload || {};
      if (!dpId) return { success: false, error: '缺少参数' };

      try {
        const { data: existingPlan } = await db.collection('day_plans').doc(dpId).get();
        if (!existingPlan) throw new Error('日程不存在');
        await requireTripWritable(existingPlan.tripId);
        if (!items || items.length === 0) {
          await db.collection('day_plans').doc(dpId).remove();
        } else {
          await db.collection('day_plans').doc(dpId).update({ data: { items } });
        }
        return { success: true };
      } catch (e) {
        console.error('deleteDayPlanItem error:', e);
        return { success: false, error: e.message || '删除失败' };
      }
    }

    // ══════ 行程投票 ══════
    case 'getTripVotes': {
      const { tripId } = payload || {};
      if (!tripId) return { success: false, error: '缺少行程 ID' };
      try {
        await requireTripMembership(tripId);
        let data = [];
        try {
          const res = await db.collection('trip_votes').where({ tripId }).orderBy('createdAt', 'desc').limit(100).get();
          data = res.data || [];
        } catch (e) {
          if (!isCollectionNotFound(e)) throw e;
        }
        const votes = data.map(vote => {
          const rawOptions = Array.isArray(vote.options) ? vote.options : [];
          const voteMap = vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
          const counts = rawOptions.map((_, optionIndex) => Object.values(voteMap).filter(value => Number(value) === optionIndex).length);
          const totalVotes = Object.keys(voteMap).length;
          return {
            ...vote,
            options: rawOptions.map((option, optionIndex) => ({
              text: String(option || ''),
              count: counts[optionIndex] || 0,
              percent: totalVotes ? Math.round((counts[optionIndex] || 0) / totalVotes * 100) : 0,
              selected: Number(voteMap[OPENID]) === optionIndex
            })),
            totalVotes,
            myChoice: voteMap[OPENID] == null ? -1 : Number(voteMap[OPENID])
          };
        });
        return { success: true, votes };
      } catch (e) {
        return { success: false, error: e.message || '获取投票失败' };
      }
    }

    case 'createTripVote': {
      const { tripId, vote } = payload || {};
      if (!tripId || !vote) return { success: false, error: '缺少投票信息' };
      try {
        const { membership } = await requireTripWritable(tripId);
        await ensureCollection('trip_votes');
        const title = String(vote.title || '').trim().slice(0, 80);
        const options = [...new Set((Array.isArray(vote.options) ? vote.options : [])
          .map(item => String(item || '').trim().slice(0, 60))
          .filter(Boolean))].slice(0, 8);
        if (!title) return { success: false, error: '请输入投票主题' };
        if (options.length < 2) return { success: false, error: '至少需要 2 个选项' };
        const type = ['spot', 'food', 'hotel', 'time', 'other'].includes(vote.type) ? vote.type : 'other';
        const now = new Date().toISOString();
        const added = await db.collection('trip_votes').add({
          data: {
            tripId,
            title,
            type,
            options,
            votes: {},
            status: 'open',
            createdBy: OPENID,
            createdByName: membership.nickName || '成员',
            createdAt: now,
            updatedAt: now
          }
        });
        return { success: true, voteId: added._id };
      } catch (e) {
        return { success: false, error: e.message || '创建投票失败' };
      }
    }

    case 'voteTripPoll': {
      const { voteId, optionIndex } = payload || {};
      if (!voteId) return { success: false, error: '缺少投票 ID' };
      try {
        const { data: vote } = await db.collection('trip_votes').doc(voteId).get();
        if (!vote) return { success: false, error: '投票不存在' };
        await requireTripMembership(vote.tripId);
        if (vote.status === 'closed') return { success: false, error: '投票已结束' };
        const index = Number(optionIndex);
        if (!Number.isInteger(index) || index < 0 || index >= (vote.options || []).length) {
          return { success: false, error: '选项无效' };
        }
        const votes = { ...(vote.votes || {}), [OPENID]: index };
        await db.collection('trip_votes').doc(voteId).update({
          data: { votes, updatedAt: new Date().toISOString() }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message || '投票失败' };
      }
    }

    case 'closeTripVote': {
      const { voteId } = payload || {};
      if (!voteId) return { success: false, error: '缺少投票 ID' };
      try {
        const { data: vote } = await db.collection('trip_votes').doc(voteId).get();
        if (!vote) return { success: false, error: '投票不存在' };
        const membership = await requireTripMembership(vote.tripId);
        if (vote.createdBy !== OPENID && !['creator', 'owner'].includes(membership.role)) {
          return { success: false, error: '只有发起人或创建者可结束投票' };
        }
        await db.collection('trip_votes').doc(voteId).update({
          data: { status: 'closed', closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message || '结束投票失败' };
      }
    }

    // ══════ 全局搜索 ══════
    case 'globalSearch': {
      const keyword = String(payload && payload.keyword || '').trim().toLowerCase().slice(0, 40);
      if (!keyword) return { success: true, results: { contacts: [], chats: [], groups: [], ai: [], trips: [] } };
      const includes = value => String(value || '').toLowerCase().includes(keyword);
      const safeData = promise => promise.then(result => result.data || []).catch(() => []);
      try {
        const [sentFriends, receivedFriends, sentMessages, receivedMessages, memberships, aiConversations, tripMemberships] = await Promise.all([
          safeData(db.collection('friend_requests').where({ from: OPENID, status: 'accepted' }).limit(100).get()),
          safeData(db.collection('friend_requests').where({ to: OPENID, status: 'accepted' }).limit(100).get()),
          safeData(db.collection('private_messages').where({ from: OPENID }).limit(100).get()),
          safeData(db.collection('private_messages').where({ to: OPENID }).limit(100).get()),
          safeData(db.collection('group_members').where({ openid: OPENID }).limit(100).get()),
          safeData(db.collection('ai_conversations').where({ ownerId: OPENID }).limit(100).get()),
          safeData(db.collection('trip_members').where({ openid: OPENID }).limit(100).get())
        ]);

        const friendIds = [...new Set([
          ...sentFriends.map(item => item.to),
          ...receivedFriends.map(item => item.from)
        ].filter(Boolean))];
        const groupIds = [...new Set(memberships.map(item => item.groupId).filter(Boolean))];
        const tripIds = [...new Set(tripMemberships.map(item => item.tripId).filter(Boolean))];
        const [friends, groups, groupMessages, trips] = await Promise.all([
          friendIds.length ? safeData(db.collection('users').where({ openid: _.in(friendIds) }).limit(100).get()) : [],
          groupIds.length ? safeData(db.collection('group_chats').where({ _id: _.in(groupIds) }).limit(100).get()) : [],
          groupIds.length ? safeData(db.collection('group_messages').where({ groupId: _.in(groupIds) }).limit(200).get()) : [],
          tripIds.length ? safeData(db.collection('trips').where({ _id: _.in(tripIds) }).limit(100).get()) : []
        ]);

        const userIds = [...new Set([
          ...sentMessages.map(item => item.to),
          ...receivedMessages.map(item => item.from),
          ...groupMessages.map(item => item.from)
        ].filter(Boolean))];
        const users = userIds.length
          ? await safeData(db.collection('users').where({ openid: _.in(userIds) }).limit(100).get())
          : [];
        const userMap = {};
        [...friends, ...users].forEach(user => { userMap[user.openid] = user; });
        const groupMap = {};
        groups.forEach(group => { groupMap[group._id] = group; });

        const privateResults = [...sentMessages, ...receivedMessages]
          .filter(message => !(message.hiddenFor || []).includes(OPENID))
          .filter(message => [message.text, message.fileName, message.locationName, message.cardName, message.momentText].some(includes))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          .slice(0, 20)
          .map(message => {
            const targetOpenid = message.from === OPENID ? message.to : message.from;
            const user = userMap[targetOpenid] || {};
            return {
              id: message._id,
              type: 'private',
              targetOpenid,
              title: user.nickName || '私信',
              avatarUrl: user.avatarUrl || '',
              text: messagePreview(message),
              createdAt: message.createdAt || ''
            };
          });
        const groupResults = groupMessages
          .filter(message => !(message.hiddenFor || []).includes(OPENID))
          .filter(message => [message.text, message.fileName, message.locationName, message.cardName, message.momentText].some(includes))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          .slice(0, 20)
          .map(message => ({
            id: message._id,
            type: 'group',
            groupId: message.groupId,
            title: (groupMap[message.groupId] && groupMap[message.groupId].name) || '群聊',
            senderName: (userMap[message.from] && userMap[message.from].nickName) || '群成员',
            text: messagePreview(message),
            createdAt: message.createdAt || ''
          }));
        const results = {
          contacts: friends.filter(user => includes(user.nickName) || includes(user.publicId) || includes(user.signature)).slice(0, 20).map(user => ({
            openid: user.openid, nickName: user.nickName || '未设置', publicId: user.publicId || '', avatarUrl: user.avatarUrl || ''
          })),
          chats: privateResults,
          groups: [
            ...groups.filter(group => includes(group.name)).map(group => ({ id: group._id, type: 'group_entry', groupId: group._id, title: group.name || '群聊', text: '群聊' })),
            ...groupResults
          ].slice(0, 20),
          ai: aiConversations.filter(conversation => includes(conversation.title) || includes(conversation.preview) || (conversation.messages || []).some(message => includes(message.text)))
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
            .slice(0, 20)
            .map(conversation => ({ id: conversation._id, title: conversation.title || '新的对话', text: conversation.preview || '', updatedAt: conversation.updatedAt || '' })),
          trips: trips.filter(trip => includes(trip.name) || includes(trip.city)).slice(0, 20).map(trip => ({
            id: trip._id, title: trip.name || '未命名行程', text: [trip.city, trip.startDate, trip.endDate].filter(Boolean).join(' · ')
          }))
        };
        return { success: true, results };
      } catch (error) {
        return { success: false, error: error.message || '搜索失败' };
      }
    }

    case 'getChatMedia': {
      const targetOpenid = String(payload && payload.targetOpenid || '');
      const groupId = String(payload && payload.groupId || '');
      const allowedTypes = new Set(['image', 'voice', 'file', 'location', 'user_card', 'moment_share']);
      try {
        let messages = [];
        if (targetOpenid) {
          const conversationId = privateConversationId(OPENID, targetOpenid);
          const result = await db.collection('private_messages')
            .where({ conversationId }).orderBy('createdAt', 'desc').limit(100).get();
          messages = result.data || [];
        } else if (groupId) {
          await requireGroupMember(groupId);
          const result = await db.collection('group_messages')
            .where({ groupId }).orderBy('createdAt', 'desc').limit(100).get();
          messages = result.data || [];
        } else {
          return { success: false, error: '缺少聊天对象' };
        }
        const media = (messages || []).filter(message => allowedTypes.has(message.type) && !(message.hiddenFor || []).includes(OPENID));
        return { success: true, media };
      } catch (error) {
        return { success: false, error: error.message || '聊天文件加载失败' };
      }
    }

    // ══════ 互动通知 ══════
    case 'getNotifications': {
      try {
        await ensureCollection('notifications');
        const { data: notifications } = await db.collection('notifications')
          .where({ to: OPENID })
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        // 解析通知发送者的头像昵称
        const openids = [...new Set((notifications || []).map(n => n.from).filter(Boolean))];
        if (openids.length) {
          const userMap = {};
          const { data: users } = await db.collection('users')
            .where({ openid: _.in(openids) })
            .field({ openid: true, nickName: true, avatarUrl: true })
            .limit(openids.length)
            .get();
          (users || []).forEach(u => { userMap[u.openid] = u; });
          notifications.forEach(n => {
            const u = userMap[n.from];
            if (u) {
              n.fromNickName = u.nickName || n.fromNickName;
              n.fromAvatar = u.avatarUrl || '';
            }
          });
        }
        // 批量解析通知中的图片
        const imageIds = notifications
          .map(n => n.momentImage)
          .filter(id => id && typeof id === 'string' && id.startsWith('cloud://'));
        if (imageIds.length) {
          try {
            const urlRes = await cloud.getTempFileURL({ fileList: [...new Set(imageIds)] });
            const urlMap = {};
            (urlRes.fileList || []).forEach(f => { if (f.tempFileURL) urlMap[f.fileID] = f.tempFileURL; });
            notifications.forEach(n => {
              if (n.momentImage && urlMap[n.momentImage]) n.momentImage = urlMap[n.momentImage];
            });
          } catch (_) {}
        }
        return { success: true, notifications };
      } catch (e) {
        console.error('getNotifications error:', e);
        return { success: false, error: e.message };
      }
    }

    case 'markNotificationsRead': {
      try {
        await ensureCollection('notifications');
        const { data: unread } = await db.collection('notifications')
          .where({ to: OPENID, read: false })
          .get();
        if (unread && unread.length) {
          await Promise.all(unread.map(n =>
            db.collection('notifications').doc(n._id).update({ data: { read: true } })
          ));
        }
        return { success: true, marked: unread ? unread.length : 0 };
      } catch (e) {
        console.error('markNotificationsRead error:', e);
        return { success: false, error: e.message };
      }
    }

    case 'markNotificationRead': {
      const notificationId = String(payload && payload.notificationId || '');
      if (!notificationId) return { success: false, error: '缺少通知' };
      try {
        await ensureCollection('notifications');
        const { data: notification } = await db.collection('notifications').doc(notificationId).get();
        if (!notification || notification.to !== OPENID) return { success: false, error: '通知不存在' };
        if (!notification.read) await db.collection('notifications').doc(notificationId).update({ data: { read: true } });
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message || '更新通知失败' };
      }
    }

    // ── 当前行程打包清单 ──
    case 'getMyPacking': {
      try {
        await ensurePackingCollection();
        const trip = await requireCurrentPackingTrip();
        const items = await getPackingItemsForTrip(trip, true);
        return {
          success: true,
          items,
          currentTrip: {
            _id: trip._id,
            name: trip.name || '当前行程',
            city: trip.city || '',
            startDate: trip.startDate || '',
            endDate: trip.endDate || ''
          }
        };
      } catch (e) {
        if (/设置当前行程/.test(e.message || '')) {
          return { success: true, items: [], currentTrip: null, requiresCurrentTrip: true };
        }
        return { success: false, error: e.message };
      }
    }

    case 'addMyPackingItem': {
      const { name, category } = payload || {};
      if (!name) return { success: false, error: '请输入物品名称' };
      try {
        await ensurePackingCollection();
        const trip = await requireCurrentPackingTrip();
        const doc = {
          openid: OPENID,
          tripId: trip._id,
          name: String(name).slice(0, 50),
          category: category || 'other',
          checked: false,
          createdAt: new Date().toISOString()
        };
        const { _id } = await db.collection('user_packing').add({ data: doc });
        return { success: true, item: { ...doc, _id } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'toggleMyPackingItem': {
      const { itemId } = payload || {};
      if (!itemId) return { success: false, error: '缺少参数' };
      try {
        await ensurePackingCollection();
        const trip = await requireCurrentPackingTrip();
        const { data: doc } = await db.collection('user_packing').doc(itemId).get();
        if (!doc || doc.openid !== OPENID || doc.tripId !== trip._id) {
          return { success: false, error: '项目不存在或不属于当前行程' };
        }
        await db.collection('user_packing').doc(itemId).update({
          data: { checked: !doc.checked }
        });
        return { success: true, checked: !doc.checked };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'removeMyPackingItem': {
      const { itemId } = payload || {};
      if (!itemId) return { success: false, error: '缺少参数' };
      try {
        await ensurePackingCollection();
        const trip = await requireCurrentPackingTrip();
        const { data: doc } = await db.collection('user_packing').doc(itemId).get();
        if (!doc || doc.openid !== OPENID || doc.tripId !== trip._id) {
          return { success: false, error: '项目不存在或不属于当前行程' };
        }
        await db.collection('user_packing').doc(itemId).remove();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'getPackingHistories': {
      try {
        await ensurePackingHistoryCollection();
        const { data } = await db.collection('packing_histories')
          .where({ openid: OPENID })
          .orderBy('createdAt', 'desc')
          .limit(30)
          .get();
        const histories = (data || []).map(history => ({
          _id: history._id,
          name: history.name,
          itemCount: Number(history.itemCount) || (Array.isArray(history.items) ? history.items.length : 0),
          sourceTripName: history.sourceTripName || '',
          createdAt: history.createdAt
        }));
        return { success: true, histories };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'savePackingHistory': {
      const historyName = String(payload && payload.name || '').trim().slice(0, 30);
      try {
        await ensurePackingCollection();
        await ensurePackingHistoryCollection();
        const trip = await requireCurrentPackingTrip();
        const currentItems = await getPackingItemsForTrip(trip, true);
        if (!currentItems || !currentItems.length) {
          return { success: false, error: '当前清单还是空的' };
        }
        const items = currentItems.map(item => ({
          name: String(item.name || '').slice(0, 50),
          category: item.category || 'other'
        }));
        const now = new Date().toISOString();
        const history = {
          openid: OPENID,
          name: historyName || '未命名清单',
          sourceTripId: trip._id,
          sourceTripName: trip.name || '',
          items,
          itemCount: items.length,
          createdAt: now,
          updatedAt: now
        };
        const { _id } = await db.collection('packing_histories').add({ data: history });
        return {
          success: true,
          history: {
            _id,
            name: history.name,
            itemCount: items.length,
            sourceTripName: history.sourceTripName,
            createdAt: now
          }
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'applyPackingHistory': {
      const historyId = String(payload && payload.historyId || '');
      if (!historyId) return { success: false, error: '缺少历史清单 ID' };
      try {
        await ensurePackingCollection();
        await ensurePackingHistoryCollection();
        const trip = await requireCurrentPackingTrip();
        const { data: history } = await db.collection('packing_histories').doc(historyId).get();
        if (!history || history.openid !== OPENID) return { success: false, error: '历史清单不存在' };
        const existingItems = await getPackingItemsForTrip(trip, true);
        const existingKeys = new Set((existingItems || []).map(item =>
          `${item.category || 'other'}::${String(item.name || '').trim().toLowerCase()}`
        ));
        const itemsToAdd = (Array.isArray(history.items) ? history.items : [])
          .filter(item => item && String(item.name || '').trim())
          .filter(item => {
            const key = `${item.category || 'other'}::${String(item.name).trim().toLowerCase()}`;
            if (existingKeys.has(key)) return false;
            existingKeys.add(key);
            return true;
          })
          .slice(0, 200);
        await Promise.all(itemsToAdd.map((item, index) => db.collection('user_packing').add({
          data: {
            openid: OPENID,
            tripId: trip._id,
            name: String(item.name).trim().slice(0, 50),
            category: item.category || 'other',
            checked: false,
            createdAt: new Date(Date.now() + index).toISOString()
          }
        })));
        return { success: true, added: itemsToAdd.length };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'generatePackingSuggestions': {
      const apiKey = process.env.ZHIPU_API_KEY || '';
      if (!apiKey) return { success: false, error: 'AI 服务未配置' };
      try {
        const trip = await requireCurrentPackingTrip();
        const { data: dayPlans } = await db.collection('day_plans')
          .where({ tripId: trip._id })
          .orderBy('dayIndex', 'asc')
          .limit(30)
          .get();
        const activities = (dayPlans || []).flatMap(day => (day.items || []).map(item =>
          [item.title, item.location, item.notes].filter(Boolean).join(' · ')
        )).filter(Boolean).slice(0, 40);

        let weatherContext = '行程日期暂不在未来 7 天预报范围内，请按季节做稳妥建议。';
        try {
          const forecast = await getOpenMeteoWeather(trip.city || '');
          const relevant = forecast.filter(day =>
            (!trip.startDate || day.date >= trip.startDate) && (!trip.endDate || day.date <= trip.endDate)
          );
          if (relevant.length) {
            weatherContext = relevant.map(day =>
              `${day.date} ${day.textDay} ${day.tempLow}—${day.tempHigh}℃`
            ).join('；');
          }
        } catch (weatherError) {
          console.warn('生成清单时天气读取失败:', weatherError.message);
        }

        const systemPrompt = `你是专业的旅行打包顾问。请根据行程信息生成实用、克制且不重复的行李建议。
必须只输出 JSON，不要 markdown，不要额外文字。格式：
{"items":[{"name":"物品名称或数量","category":"clothing|toiletries|electronics|documents|medicine|other","reason":"推荐理由"}]}
规则：
- 生成 15—35 项，覆盖证件、衣物、洗漱、电子、药品和行程活动需要
- category 必须使用给定英文值
- name 简短具体，数量可写成“换洗衣物 x3”
- reason 不超过 24 个汉字，只说明与目的地、天气或活动的关系
- 不确定的特殊药品或专业装备不要武断推荐
- 不要加入航空或当地法规可能禁止携带的危险物品`;
        const userMessage = `行程：${trip.name || '当前行程'}
目的地：${trip.city || '未填写'}
日期：${trip.startDate || '未填写'} 至 ${trip.endDate || '未填写'}
天数：${trip.totalDays || 1} 天
天气：${weatherContext}
活动：${activities.length ? activities.join('；') : '尚未添加具体活动，请按常规旅行生成'}`;
        const raw = await callZhipuText(apiKey, systemPrompt, userMessage, 2200);
        const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('AI 未返回可用清单');
        const parsed = JSON.parse(clean.slice(start, end + 1));
        const normalized = normalizePackingInput(parsed.items);
        if (!normalized.length) throw new Error('AI 没有生成有效物品');
        const reasonByKey = new Map((Array.isArray(parsed.items) ? parsed.items : []).map(item => [
          `${item && item.category || 'other'}::${String(item && item.name || '').trim().toLowerCase()}`,
          String(item && item.reason || '').trim().slice(0, 40)
        ]));
        const suggestions = normalized.map(item => ({
          ...item,
          reason: reasonByKey.get(`${item.category}::${item.name.toLowerCase()}`) || ''
        }));
        return {
          success: true,
          suggestions,
          currentTrip: { _id: trip._id, name: trip.name || '当前行程', city: trip.city || '' }
        };
      } catch (e) {
        return { success: false, error: e.message || 'AI 清单生成失败' };
      }
    }

    case 'addGeneratedPackingItems': {
      try {
        await ensurePackingCollection();
        const trip = await requireCurrentPackingTrip();
        const inputItems = normalizePackingInput(payload && payload.items);
        if (!inputItems.length) return { success: false, error: '请至少选择一件物品' };
        const existingItems = await getPackingItemsForTrip(trip, true);
        const existingKeys = new Set(existingItems.map(item =>
          `${item.category || 'other'}::${String(item.name || '').trim().toLowerCase()}`
        ));
        const itemsToAdd = inputItems.filter(item => {
          const key = `${item.category}::${item.name.toLowerCase()}`;
          if (existingKeys.has(key)) return false;
          existingKeys.add(key);
          return true;
        });
        await Promise.all(itemsToAdd.map((item, index) => db.collection('user_packing').add({
          data: {
            openid: OPENID,
            tripId: trip._id,
            name: item.name,
            category: item.category,
            checked: false,
            source: 'ai',
            createdAt: new Date(Date.now() + index).toISOString()
          }
        })));
        return { success: true, added: itemsToAdd.length, skipped: inputItems.length - itemsToAdd.length };
      } catch (e) {
        return { success: false, error: e.message || '添加智能清单失败' };
      }
    }

    case 'deletePackingHistory': {
      const historyId = String(payload && payload.historyId || '');
      if (!historyId) return { success: false, error: '缺少历史清单 ID' };
      try {
        await ensurePackingHistoryCollection();
        const { data: history } = await db.collection('packing_histories').doc(historyId).get();
        if (!history || history.openid !== OPENID) return { success: false, error: '历史清单不存在' };
        await db.collection('packing_histories').doc(historyId).remove();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `未知操作: ${action}` };
  }
};
