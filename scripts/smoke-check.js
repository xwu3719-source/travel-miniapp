const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const failures = [];
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

const jsFiles = [...walk(path.join(root, 'miniprogram')), ...walk(path.join(root, 'cloudfunctions'))]
  .filter(file => file.endsWith('.js') && !file.includes(`${path.sep}node_modules${path.sep}`));
jsFiles.forEach(file => {
  try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }); }
  catch (error) { failures.push(`JS 语法: ${path.relative(root, file)}: ${error.message}`); }
});

const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
(app.pages || []).forEach(page => ['js', 'wxml', 'wxss', 'json'].forEach(ext => {
  const file = path.join(root, 'miniprogram', `${page}.${ext}`);
  if (!fs.existsSync(file)) failures.push(`页面文件缺失: ${page}.${ext}`);
}));

const clientFiles = walk(path.join(root, 'miniprogram')).filter(file => /\.(js|wxml)$/.test(file));
clientFiles.forEach(file => {
  const text = fs.readFileSync(file, 'utf8');
  if (/sizeType\s*:\s*\[['"]compressed['"]\]/.test(text)) failures.push(`仍在压缩选图: ${path.relative(root, file)}`);
  for (const match of text.matchAll(/(?:src|iconPath|selectedIconPath)=["'](\/images\/[^"']+)["']/g)) {
    if (match[1].includes('{{')) continue;
    const asset = path.join(root, 'miniprogram', match[1].slice(1));
    if (!fs.existsSync(asset)) failures.push(`图标缺失: ${match[1]} (${path.relative(root, file)})`);
  }
});

const directDb = clientFiles.filter(file => file.includes(`${path.sep}pages${path.sep}`)).flatMap(file => {
  const text = fs.readFileSync(file, 'utf8');
  return /(?:cloud\.db|cloud\.collection|db\.collection)\s*\(/.test(text) ? [path.relative(root, file)] : [];
});
if (directDb.length) failures.push(`页面仍直查数据库: ${directDb.join(', ')}`);

const regressionContracts = [
  ['好友', 'getFriendCenter'], ['屏蔽', 'updateSocialPreference'], ['状态隐私', 'showMoodStatus'],
  ['已读', 'hideReadReceipts'], ['分享', "case 'share'"], ['邀请', 'sendTripInvitation']
];
const cloudSource = ['dbOps', 'momentOps'].map(name =>
  fs.readFileSync(path.join(root, `cloudfunctions/${name}/index.js`), 'utf8')
).join('\n');
const accountCloudSource = fs.readFileSync(path.join(root, 'cloudfunctions/accountOps/index.js'), 'utf8');
regressionContracts.forEach(([label, token]) => {
  if (!cloudSource.includes(token)) failures.push(`双账号回归契约缺失: ${label} (${token})`);
});

const aiContracts = [
  ['写操作确认入口', "case 'confirmAiAction'"],
  ['写操作白名单', 'XIXI_WRITE_TOOLS'],
  ['客户端确认调用', 'confirmAiAction'],
  ['会话列表', "case 'listAiConversations'"],
  ['会话恢复', "case 'getAiConversation'"],
  ['会话删除', "case 'deleteAiConversation'"],
  ['操作状态持久化', "case 'updateAiConversationAction'"],
  ['客户端会话管理', 'listAiConversations']
];
const clientCloudSource = fs.readFileSync(path.join(root, 'miniprogram/utils/cloud.js'), 'utf8');
aiContracts.forEach(([label, token]) => {
  const source = label.startsWith('客户端') ? clientCloudSource : cloudSource;
  if (!source.includes(token)) failures.push(`AI 操作契约缺失: ${label} (${token})`);
});

const archiveContracts = [
  ['历史行程只读', 'requireTripWritable'],
  ['保存行程模板', "case 'saveTripTemplate'"],
  ['从历史或模板复制', "case 'createTripFromSource'"],
  ['客户端模板入口', 'getTripTemplates']
];
archiveContracts.forEach(([label, token]) => {
  const source = label === '客户端模板入口' ? clientCloudSource : cloudSource;
  if (!source.includes(token)) failures.push(`历史复用契约缺失: ${label} (${token})`);
});

const packingHistoryContracts = [
  ['读取历史清单', "case 'getPackingHistories'"],
  ['保存历史清单', "case 'savePackingHistory'"],
  ['恢复历史清单', "case 'applyPackingHistory'"],
  ['当前行程隔离', 'requireCurrentPackingTrip'],
  ['AI 生成建议', "case 'generatePackingSuggestions'"],
  ['批量确认写入', "case 'addGeneratedPackingItems'"],
  ['客户端历史入口', 'getPackingHistories']
];
packingHistoryContracts.forEach(([label, token]) => {
  const source = label === '客户端历史入口' ? clientCloudSource : cloudSource;
  if (!source.includes(token)) failures.push(`行李历史契约缺失: ${label} (${token})`);
});

const productExpansionContracts = [
  ['全局搜索服务', "case 'globalSearch'", cloudSource],
  ['聊天文件服务', "case 'getChatMedia'", cloudSource],
  ['通知单条已读', "case 'markNotificationRead'", cloudSource],
  ['AI 会话重命名置顶', "case 'updateAiConversation'", cloudSource],
  ['多设备会话', "case 'listSessions'", accountCloudSource],
  ['退出其他设备', "case 'revokeOtherSessions'", accountCloudSource],
  ['本地草稿恢复', "require('../../utils/drafts')", clientFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n')],
  ['全局搜索页面', 'pages/global-search/global-search', JSON.stringify(app.pages || [])],
  ['聊天文件页面', 'pages/chat-media/chat-media', JSON.stringify(app.pages || [])],
  ['通知中心页面', 'pages/notification-center/notification-center', JSON.stringify(app.pages || [])],
  ['全局消息弹窗组件', 'message-popup', JSON.stringify(app.usingComponents || {})],
  ['私信弹窗监听', 'preparePrivateMessageNotify', fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8')],
  ['群聊弹窗监听', 'prepareGroupMessageNotify', fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8')],
  ['群聊免打扰', 'myNotificationsMuted', cloudSource],
  ['会话列表快照', '_conversationListSnapshot', fs.readFileSync(path.join(root, 'miniprogram/pages/messages/messages.js'), 'utf8')],
  ['消息优先渲染', 'const chatPromise = cloud.getPrivateChat', fs.readFileSync(path.join(root, 'miniprogram/pages/private-chat/private-chat.js'), 'utf8')],
  ['文件路径兼容', 'file.path || file.tempFilePath', fs.readFileSync(path.join(root, 'miniprogram/pages/private-chat/private-chat.js'), 'utf8')],
  ['文件类型显式传递', 'fileType: ext', fs.readFileSync(path.join(root, 'miniprogram/pages/private-chat/private-chat.js'), 'utf8')],
  ['长文件名保留扩展名', '100 - suffix.length', cloudSource],
  ['云文件直接下载', 'wx.cloud.downloadFile', clientCloudSource],
  ['消息弹窗增量兜底', "case 'getLatestInboxEvents'", cloudSource],
  ['设置开关即时回写', '[`privacySettings.${key}`]: value', fs.readFileSync(path.join(root, 'miniprogram/pages/settings/settings.js'), 'utf8')],
  ['弹窗头像临时链接', 'resolveMessageAvatar', fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8')]
];
productExpansionContracts.forEach(([label, token, source]) => {
  if (!source.includes(token)) failures.push(`产品扩展契约缺失: ${label} (${token})`);
});

if (failures.length) {
  console.error(failures.map(item => `✗ ${item}`).join('\n'));
  process.exit(1);
}
console.log(`✓ 冒烟检查通过：${jsFiles.length} 个 JS 文件、${(app.pages || []).length} 个页面、6 项双账号契约、8 项 AI 会话契约、4 项历史复用契约、7 项行李清单契约、23 项产品扩展契约`);
