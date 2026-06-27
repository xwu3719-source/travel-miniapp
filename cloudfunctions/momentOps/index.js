const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const resolveOpenid = require('./resolveOpenid');
const CLOUD_VERSION = '2026.06.21.2';

async function getUser(openid) {
  try {
    const byOpenid = await db.collection('users').where({ openid }).limit(1).get();
    if (byOpenid.data && byOpenid.data.length) return byOpenid.data[0];
    const byUid = await db.collection('users').where({ uid: openid }).limit(1).get();
    return byUid.data && byUid.data.length ? byUid.data[0] : null;
  } catch (_) {
    return null;
  }
}

/**
 * 动态操作云函数
 * 所有写操作在服务端执行，绕过客户端集合权限限制
 * - like：点赞/取消点赞
 * - favorite：收藏/取消收藏
 * - comment：添加评论（支持回复）
 * - 点赞和评论自动发送通知给动态作者
 */
exports.main = async (event, context) => {
  const { OPENID: wxOpenid } = cloud.getWXContext();
  if (!wxOpenid) {
    return { success: false, error: '未登录' };
  }

  const OPENID = await resolveOpenid(db, wxOpenid, event._sessionToken || '');

  const { action, momentId, comment } = event;

  // 生成简短评论 ID
  function genCid() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // 发送互动通知给动态作者
  async function notifyInteraction(type, moment, fromNickName, commentText) {
    if (moment.authorId === OPENID) return; // 不给自己发通知
    try {
      const notification = {
        type,
        momentId: moment._id,
        to: moment.authorId,
        from: OPENID,
        fromNickName,
        read: false,
        createdAt: new Date().toISOString()
      };
      if (commentText) notification.text = commentText.slice(0, 100);
      // 附带动态文字摘要，方便消息列表预览
      if (moment.text) notification.momentText = moment.text.slice(0, 80);
      if (moment.images && moment.images.length) notification.momentImage = moment.images[0];
      await db.collection('notifications').add({ data: notification });
    } catch (_) {
      // 通知发送失败不影响主操作
    }
  }

  async function getMoment() {
    if (!momentId) throw new Error('缺少 momentId');
    const { data } = await db.collection('moments').doc(momentId).get();
    if (!data) throw new Error('动态不存在');
    return data;
  }

  function assertOwner(moment) {
    if (moment.authorId !== OPENID) throw new Error('无权限操作该动态');
  }

  function assertCanInteract(moment) {
    if (moment.isPrivate === true && moment.authorId !== OPENID) {
      throw new Error('该动态不可互动');
    }
  }

  async function requireTripMember(tripId) {
    if (!tripId) throw new Error('缺少 tripId');
    const { data } = await db.collection('trip_members')
      .where({ tripId, openid: OPENID })
      .limit(1)
      .get();
    if (!data.length) throw new Error('你还不是该行程成员');
  }

  async function requireTripWritable(tripId) {
    await requireTripMember(tripId);
    const { data: trip } = await db.collection('trips').doc(tripId).get();
    if (!trip) throw new Error('行程不存在');
    if (trip.status === 'archived') throw new Error('历史行程为只读，请先恢复行程');
  }

  switch (action) {

    case 'healthCheck':
      return { success: true, functionName: 'momentOps', version: CLOUD_VERSION };

    case 'create': {
      try {
        const input = event.moment || {};
        const tripId = String(input.tripId || '');
        const text = String(input.text || '').trim().slice(0, 500);
        const images = Array.isArray(input.images)
          ? input.images.filter(item => typeof item === 'string' && item).slice(0, 9)
          : [];
        const videos = Array.isArray(input.videos)
          ? input.videos
            .filter(item => item && typeof item.fileID === 'string' && item.fileID)
            .slice(0, 1)
            .map(item => ({ fileID: item.fileID, duration: Math.max(0, Number(item.duration) || 0) }))
          : [];
        if (!text && !images.length && !videos.length) throw new Error('动态内容不能为空');
        await requireTripWritable(tripId);

        const user = await getUser(OPENID);
        const moment = {
          tripId,
          authorId: OPENID,
          authorName: (user && user.nickName) || '我',
          authorAvatar: (user && user.avatarUrl) || '',
          text,
          images,
          videos,
          location: String(input.location || '').trim().slice(0, 100),
          dayIndex: Math.max(0, Number(input.dayIndex) || 0),
          isPrivate: input.isPrivate === true,
          likes: [],
          favorites: [],
          comments: [],
          shareCount: 0,
          createdAt: new Date().toISOString()
        };
        const result = await db.collection('moments').add({ data: moment });
        return { success: true, moment: { ...moment, _id: result._id } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'like': {
      if (!momentId) return { success: false, error: '缺少 momentId' };
      try {
        const { data: moment } = await db.collection('moments').doc(momentId).get();
        if (!moment) return { success: false, error: '动态不存在' };
        assertCanInteract(moment);
        await requireTripWritable(moment.tripId);
        const likes = moment.likes || [];
        const idx = likes.indexOf(OPENID);
        const isNewLike = idx === -1;
        if (idx > -1) likes.splice(idx, 1);
        else likes.push(OPENID);
        await db.collection('moments').doc(momentId).update({ data: { likes } });
        // 点赞时发送通知
        if (isNewLike) {
          const user = await getUser(OPENID);
          await notifyInteraction('like', moment, (user && user.nickName) || '我');
        }
        return { success: true, liked: isNewLike, likes };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'favorite': {
      if (!momentId) return { success: false, error: '缺少 momentId' };
      try {
        const { data: moment } = await db.collection('moments').doc(momentId).get();
        if (!moment) return { success: false, error: '动态不存在' };
        assertCanInteract(moment);
        await requireTripWritable(moment.tripId);
        const favorites = moment.favorites || [];
        const idx = favorites.indexOf(OPENID);
        if (idx > -1) favorites.splice(idx, 1);
        else favorites.push(OPENID);
        await db.collection('moments').doc(momentId).update({ data: { favorites } });
        return { success: true, favorited: idx === -1, favorites };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'share': {
      if (!momentId) return { success: false, error: '缺少 momentId' };
      try {
        const moment = await getMoment();
        assertCanInteract(moment);
        await requireTripWritable(moment.tripId);
        const count = Math.max(1, Math.min(50, Number(event.count) || 1));
        await db.collection('moments').doc(momentId).update({
          data: { shareCount: db.command.inc(count) }
        });
        const updated = await getMoment();
        return { success: true, shareCount: Number(updated.shareCount) || count };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'comment': {
      if (!momentId) return { success: false, error: '缺少 momentId' };
      if (!comment) return { success: false, error: '缺少 comment' };
      const text = (comment.text || '').trim();
      if (!text && !comment.image && !comment.voice && !comment.location) {
        return { success: false, error: '评论内容不能为空' };
      }
      try {
        const { data: moment } = await db.collection('moments').doc(momentId).get();
        if (!moment) return { success: false, error: '动态不存在' };
        assertCanInteract(moment);
        await requireTripWritable(moment.tripId);

        const user = await getUser(OPENID);
        const nickName = (user && user.nickName) || '我';

        const comments = moment.comments || [];
        const newComment = {
          _cid: genCid(),
          openid: OPENID,
          nickName,
          text,
          createdAt: new Date().toISOString()
        };
        if (comment.image) newComment.image = comment.image;
        if (comment.voice) { newComment.voice = comment.voice; newComment.voiceDuration = comment.voiceDuration || 0; }
        if (comment.location) newComment.location = comment.location;
        // 回复某人
        if (comment.replyTo) {
          newComment.replyTo = {
            _cid: comment.replyTo._cid || '',
            openid: comment.replyTo.openid || '',
            nickName: comment.replyTo.nickName || ''
          };
        }
        comments.push(newComment);

        await db.collection('moments').doc(momentId).update({ data: { comments } });
        // 评论时发送通知
        await notifyInteraction('comment', moment, nickName, text);
        return { success: true, comments };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'editComment': {
      const editCommentId = event.commentId || '';
      const newText = (event.text || '').trim();
      if (!momentId || !editCommentId) return { success: false, error: '缺少 momentId 或 commentId' };
      if (!newText) return { success: false, error: '评论内容不能为空' };
      if (newText.length > 500) return { success: false, error: '评论不能超过500字' };
      try {
        const { data: editMoment } = await db.collection('moments').doc(momentId).get();
        if (!editMoment) return { success: false, error: '动态不存在' };
        await requireTripWritable(editMoment.tripId);
        const editComments = editMoment.comments || [];
        const editTarget = editComments.find(c => c._cid === editCommentId);
        if (!editTarget) return { success: false, error: '评论不存在' };
        if (editTarget.openid !== OPENID) return { success: false, error: '只能编辑自己的评论' };
        editTarget.text = newText;
        editTarget.editedAt = new Date().toISOString();
        await db.collection('moments').doc(momentId).update({ data: { comments: editComments } });
        return { success: true, comments: editComments };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'deleteComment': {
      const commentId = event.commentId || '';
      if (!momentId || !commentId) return { success: false, error: '缺少 momentId 或 commentId' };
      try {
        const { data: moment } = await db.collection('moments').doc(momentId).get();
        if (!moment) return { success: false, error: '动态不存在' };
        await requireTripWritable(moment.tripId);
        const comments = moment.comments || [];
        const target = comments.find(c => c._cid === commentId);
        if (!target) return { success: false, error: '评论不存在' };
        // 评论作者或动态作者都可以删除
        if (target.openid !== OPENID && moment.authorId !== OPENID) {
          return { success: false, error: '无权限删除该评论' };
        }
        const updated = comments.filter(c => c._cid !== commentId);
        await db.collection('moments').doc(momentId).update({ data: { comments: updated } });
        return { success: true, comments: updated };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'update': {
      try {
        const moment = await getMoment();
        assertOwner(moment);
        await requireTripWritable(moment.tripId);
        const updateData = {};
        if (typeof event.text === 'string') updateData.text = event.text.trim();
        if (Array.isArray(event.images)) updateData.images = event.images;
        if (Array.isArray(event.videos)) updateData.videos = event.videos;
        if (typeof event.location === 'string') updateData.location = event.location.trim();
        if (event.dayIndex !== undefined) updateData.dayIndex = Number(event.dayIndex) || 0;
        updateData.updatedAt = new Date().toISOString();
        await db.collection('moments').doc(momentId).update({ data: updateData });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'togglePrivate': {
      try {
        const moment = await getMoment();
        assertOwner(moment);
        await requireTripWritable(moment.tripId);
        const isPrivate = !moment.isPrivate;
        await db.collection('moments').doc(momentId).update({ data: { isPrivate } });
        return { success: true, isPrivate };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'delete': {
      try {
        const moment = await getMoment();
        assertOwner(moment);
        await requireTripWritable(moment.tripId);
        await db.collection('moments').doc(momentId).remove();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ══════ 用户动态互动统计 ══════
    case 'getMyMomentStats': {
      try {
        const { total } = await db.collection('moments')
          .where({ authorId: OPENID })
          .count();

        const { data: moments } = await db.collection('moments')
          .where({ authorId: OPENID })
          .limit(100)
          .get();

        let totalLikes = 0, totalFavorites = 0, totalComments = 0;
        (moments || []).forEach(m => {
          totalLikes += (m.likes || []).length;
          totalFavorites += (m.favorites || []).length;
          totalComments += (m.comments || []).length;
        });

        return {
          success: true,
          stats: { momentCount: total, totalLikes, totalFavorites, totalComments }
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `未知操作: ${action}` };
  }
};
