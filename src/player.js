/**
 * Audio Player Engine
 * Manages HTMLAudioElement playback, sequential play, seeking, speed, volume,
 * and full Media Session API for Bluetooth/headset/lock screen controls.
 */

export class AudioPlayer {
  constructor() {
    /** @type {HTMLAudioElement} */
    this.audio = new Audio();
    this.audio.preload = 'metadata';

    /** @type {import('./fileLoader.js').AudioFile[]} */
    this.playlist = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    this.speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    this.speedIndex = 2;

    // Event callbacks
    this.onTimeUpdate = null;
    this.onTrackChange = null;
    this.onPlayStateChange = null;
    this.onEnded = null;

    this._bindEvents();
    this._setupMediaSession();
  }

  _bindEvents() {
    this.audio.addEventListener('timeupdate', () => {
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.audio.currentTime, this.audio.duration);
      }
      this._updatePositionState();
    });

    this.audio.addEventListener('ended', () => {
      if (this.onEnded) this.onEnded();
      this.next();
    });

    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      this._setMediaPlaybackState('playing');
      if (this.onPlayStateChange) this.onPlayStateChange(true);
    });

    this.audio.addEventListener('pause', () => {
      this.isPlaying = false;
      this._setMediaPlaybackState('paused');
      if (this.onPlayStateChange) this.onPlayStateChange(false);
    });

    this.audio.addEventListener('loadedmetadata', () => {
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.audio.currentTime, this.audio.duration);
      }
      this._updatePositionState();
    });
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      this.skip(-(details.seekOffset || 30));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      this.skip(details.seekOffset || 30);
    });
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) {
          this.audio.currentTime = details.seekTime;
        }
      });
    } catch (e) { /* seekto not supported */ }
    try {
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
      });
    } catch (e) { /* stop not supported */ }
  }

  _setMediaPlaybackState(state) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
  }

  _updatePositionState() {
    if (!('mediaSession' in navigator)) return;
    if (!this.audio.duration || !isFinite(this.audio.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: this.audio.duration,
        playbackRate: this.audio.playbackRate,
        position: Math.min(this.audio.currentTime, this.audio.duration)
      });
    } catch (e) { /* ignore */ }
  }

  /**
   * Update the Media Session metadata (shown on lock screen / Bluetooth).
   * @param {string} title
   * @param {string} artist
   * @param {string} album
   */
  setMediaMetadata(title, artist, album) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: artist || 'Audiobook Player',
      album: album || 'Audiobook'
    });
  }

  /**
   * Set the playlist.
   * @param {import('./fileLoader.js').AudioFile[]} files
   */
  setPlaylist(files) {
    this.playlist = files;
    this.currentIndex = -1;
  }

  /**
   * Play a specific track by index.
   * @param {number} index
   * @param {number} [startTime=0]
   */
  playTrack(index, startTime = 0) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    const track = this.playlist[index];
    this.audio.src = track.objectUrl;
    this.audio.currentTime = startTime;
    this.audio.play().catch(() => {});
    if (this.onTrackChange) this.onTrackChange(index, track);
  }

  play() {
    if (this.currentIndex < 0 && this.playlist.length > 0) {
      this.playTrack(0);
    } else {
      this.audio.play().catch(() => {});
    }
  }

  pause() {
    this.audio.pause();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  next() {
    if (this.currentIndex < this.playlist.length - 1) {
      this.playTrack(this.currentIndex + 1);
    }
  }

  prev() {
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
    } else if (this.currentIndex > 0) {
      this.playTrack(this.currentIndex - 1);
    }
  }

  skip(seconds) {
    if (!this.audio.duration) return;
    const t = Math.max(0, Math.min(this.audio.duration, this.audio.currentTime + seconds));
    this.audio.currentTime = t;
  }

  seekTo(fraction) {
    if (!this.audio.duration) return;
    this.audio.currentTime = fraction * this.audio.duration;
  }

  setVolume(value) {
    this.audio.volume = Math.max(0, Math.min(1, value));
  }

  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % this.speeds.length;
    const speed = this.speeds[this.speedIndex];
    this.audio.playbackRate = speed;
    return speed;
  }

  getCurrentTrack() {
    if (this.currentIndex < 0 || this.currentIndex >= this.playlist.length) return null;
    return this.playlist[this.currentIndex];
  }

  getCurrentTime() {
    return this.audio.currentTime;
  }

  getDuration() {
    return this.audio.duration || 0;
  }
}
