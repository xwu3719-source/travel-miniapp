/**
 * 语音录制 behavior
 * 封装录音管理器的事件绑定、计时、上传逻辑。
 * 页面需在 data 中声明：
 *   commentRecording: false,
 *   recordingDuration: 0,
 *   commentVoice: '',
 *   commentVoiceDuration: 0
 * 并在 wxml 中调用 onToggleVoice / onRemoveCommentVoice
 */
const cloud = require('../utils/cloud');
const recorderManager = wx.getRecorderManager();

module.exports = Behavior({
  data: {
    commentRecording: false,
    recordingDuration: 0,
    commentVoice: '',
    commentVoiceDuration: 0
  },

  lifetimes: {
    attached() {
      // 标记本轮录音是否属于当前页面
      this._ownsCommentRecording = false;
      this._recordingTimer = null;

      this._onRecorderStop = (res) => {
        if (!this._ownsCommentRecording) return;
        this._ownsCommentRecording = false;
        this.setData({ commentRecording: false, recordingDuration: 0 });
        this._clearRecordingTimer();
        if (!res.tempFilePath) return;
        cloud.uploadFile(res.tempFilePath, 'mp3', 'voices').then(fileID => {
          this.setData({
            commentVoice: fileID,
            commentVoiceDuration: Math.round((res.duration || 0) / 1000)
          });
        }).catch(() => {
          wx.showToast({ title: '语音上传失败', icon: 'none' });
        });
      };

      this._onRecorderError = () => {
        if (!this._ownsCommentRecording) return;
        this._ownsCommentRecording = false;
        this.setData({ commentRecording: false, recordingDuration: 0 });
        this._clearRecordingTimer();
        wx.showToast({ title: '录音失败', icon: 'none' });
      };

      recorderManager.onStop(this._onRecorderStop);
      recorderManager.onError(this._onRecorderError);
    },

    detached() {
      // 清理：停止录音 + 移除监听，避免内存泄漏和跨页面串音
      if (this._ownsCommentRecording) {
        try { recorderManager.stop(); } catch (_) {}
        this._ownsCommentRecording = false;
      }
      this._clearRecordingTimer();
      // 移除当前页面注册的回调
      recorderManager.offStop(this._onRecorderStop);
      recorderManager.offError(this._onRecorderError);
    }
  },

  methods: {
    onToggleVoice() {
      if (this.data.commentRecording) {
        recorderManager.stop();
        this._clearRecordingTimer();
      } else {
        this._ownsCommentRecording = true;
        this.setData({ commentRecording: true, recordingDuration: 0 });
        this._recordingTimer = setInterval(() => {
          this.setData({ recordingDuration: this.data.recordingDuration + 1 });
        }, 1000);
        recorderManager.start({ format: 'mp3' });
      }
    },

    onRemoveCommentVoice() {
      this.setData({ commentVoice: '', commentVoiceDuration: 0 });
    },

    _clearRecordingTimer() {
      if (this._recordingTimer) {
        clearInterval(this._recordingTimer);
        this._recordingTimer = null;
      }
    }
  }
});
