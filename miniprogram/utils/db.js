/**
 * 本地存储数据库（云开发降级方案）
 * API 兼容 wx.cloud.database，无网络时也能使用
 */
const STORAGE_PREFIX = 'travel_db_';

function genId() {
  return 'loc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function read(collection) {
  try {
    return wx.getStorageSync(STORAGE_PREFIX + collection) || [];
  } catch (e) {
    return [];
  }
}

function write(collection, data) {
  wx.setStorageSync(STORAGE_PREFIX + collection, data);
}

// command 支持
const command = {
  in: function (arr) {
    return { _in: arr };
  }
};

// where 条件匹配
function match(doc, condition) {
  if (!condition) return true;
  for (const key of Object.keys(condition)) {
    const val = condition[key];
    if (val && val._in) {
      if (!val._in.includes(doc[key])) return false;
    } else {
      if (doc[key] !== val) return false;
    }
  }
  return true;
}

function Query(collection) {
  this._collection = collection;
  this._where = null;
  this._orderBy = null;
  this._orderDir = 'asc';
}

Query.prototype.where = function (condition) {
  this._where = condition;
  return this;
};

Query.prototype.orderBy = function (field, dir) {
  this._orderBy = field;
  this._orderDir = dir || 'asc';
  return this;
};

Query.prototype.get = function () {
  return new Promise((resolve) => {
    let data = read(this._collection);
    if (this._where) {
      data = data.filter(d => match(d, this._where));
    }
    if (this._orderBy) {
      const field = this._orderBy;
      const dir = this._orderDir === 'desc' ? -1 : 1;
      data.sort((a, b) => {
        if (a[field] < b[field]) return -1 * dir;
        if (a[field] > b[field]) return 1 * dir;
        return 0;
      });
    }
    resolve({ data });
  });
};

Query.prototype.add = function ({ data }) {
  return new Promise((resolve) => {
    const items = read(this._collection);
    data._id = genId();
    items.push(data);
    write(this._collection, items);
    resolve({ _id: data._id });
  });
};

// 返回的 db 对象
const db = {
  command,
  collection(name) {
    const self = this;
    return {
      where(condition) {
        return new Query(name).where(condition);
      },
      doc(id) {
        return {
          get() {
            return new Promise((resolve) => {
              const items = read(name);
              const found = items.find(i => i._id === id);
              resolve({ data: found ? [found] : [] });
            });
          },
          update({ data }) {
            return new Promise((resolve) => {
              const items = read(name);
              const idx = items.findIndex(i => i._id === id);
              if (idx !== -1) {
                Object.assign(items[idx], data);
                write(name, items);
              }
              resolve();
            });
          },
          remove() {
            return new Promise((resolve) => {
              const items = read(name).filter(i => i._id !== id);
              write(name, items);
              resolve();
            });
          }
        };
      },
      add({ data }) {
        return new Query(name).add({ data });
      },
      orderBy(field, dir) {
        return new Query(name).orderBy(field, dir);
      },
      get() {
        return new Query(name).get();
      }
    };
  }
};

module.exports = db;
