/**
 * Main Entry Point — Auralis Audiobook Player PWA
 * Manages library of books, per-book progress, auto-continue, and UI wiring.
 * Uses File System Access API for persistent folder access across sessions.
 */

import './style.css';
import { extractBooks, readDirectoryHandle, sortFiles, formatSize } from './fileLoader.js';
import { AudioPlayer } from './player.js';
import { LibraryManager, BookmarkManager, formatTime, hashId } from './bookmarks.js';

// --- Instances ---
const player = new AudioPlayer();
const library = new LibraryManager();
const bookmarks = new BookmarkManager();

// --- State ---
/** @type {Map<string, import('./fileLoader.js').AudioFile[]>} bookId → chapters */
const loadedChapters = window.__auralis_chapters || new Map();
window.__auralis_chapters = loadedChapters;

/** @type {string|null} currently active book ID */
let activeBookId = null;

/** @type {string} current chapter sort */
let currentSort = 'natural';

/** @type {'library'|'chapters'} current view */
let currentView = 'library';

/** Whether File System Access API is available */
const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';

// --- DOM Refs ---
const $ = (id) => document.getElementById(id);
const $folderInput = $('folder-input');
const $btnLoadFolder = $('btn-load-folder');
const $btnLoadEmpty = $('btn-load-empty');
const $emptyState = $('empty-state');
const $librarySection = $('library-section');
const $libraryList = $('library-list');
const $libraryCount = $('library-count');
const $chaptersSection = $('chapters-section');
const $chaptersTitle = $('chapters-title');
const $chapterCount = $('chapter-count');
const $chapterList = $('chapter-list');
const $btnBackLibrary = $('btn-back-library');
const $sortSelect = $('sort-select');
const $bookmarksSection = $('bookmarks-section');
const $bookmarkList = $('bookmark-list');
const $bookmarkCount = $('bookmark-count');
const $btnAddBookmark = $('btn-add-bookmark');
const $noBookmarks = $('no-bookmarks');
const $playerBar = $('player-bar');
const $nowPlayingTitle = $('now-playing-title');
const $nowPlayingBook = $('now-playing-book');
const $timeCurrent = $('time-current');
const $timeTotal = $('time-total');
const $progressBar = $('progress-bar');
const $progressFill = $('progress-fill');
const $progressThumb = $('progress-thumb');
const $btnPlay = $('btn-play');
const $iconPlay = $('icon-play');
const $iconPause = $('icon-pause');
const $btnPrev = $('btn-prev');
const $btnNext = $('btn-next');
const $btnRewind = $('btn-rewind');
const $btnForward = $('btn-forward');
const $btnSpeed = $('btn-speed');
const $speedLabel = $('speed-label');
const $btnVolume = $('btn-volume');
const $volumeSlider = $('volume-slider');
const $loadingOverlay = $('loading-overlay');
const $loadingText = $('loading-text');
const $loadingProgressContainer = $('loading-progress-container');
const $loadingProgressFill = $('loading-progress-fill');
const $loadingProgressText = $('loading-progress-text');
const $btnAbout = $('btn-about');
const $aboutModal = $('about-modal');
const $aboutClose = $('about-close');

// ============================================================
// STARTUP — seamless auto-restore
// ============================================================

const $continueOverlay = $('continue-overlay');
const $btnContinue = $('btn-continue');

/** Whether we need user gesture to re-grant file access */
let needsPermissionGrant = false;

async function init() {
  const books = await library.getAllBooks();

  if (books.length > 0) {
    $emptyState.classList.add('hidden');
    showLibraryView();

    // Step 1: Try to restore from cached blobs (works on Android and everywhere)
    const blobsRestored = await restoreFromBlobCache(books);

    // Step 2: If not fully restored from blobs, try directory handles (desktop)
    if (!blobsRestored) {
      await restoreFolderHandles();
    }

    // Always render library from IndexedDB — books persist until deleted
    await renderLibrary();
    updateReconnectBanner();

    if (loadedChapters.size > 0) {
      // Auto-continue last book
      const lastBookId = await library.getLastBookId();
      if (lastBookId && loadedChapters.has(lastBookId)) {
        await switchToBook(lastBookId, true);
      }
    }
  }
}

/**
 * Try to auto-restore all stored directory handles.
 * Returns true if ALL handles were successfully restored.
 */
async function restoreFolderHandles() {
  if (!hasDirectoryPicker) return false;

  let handles;
  try {
    handles = await library.getAllFolderHandles();
  } catch (e) {
    return false;
  }

  if (!handles || handles.length === 0) return false;

  let allGranted = true;

  for (const entry of handles) {
    try {
      const handle = entry.handle;
      if (!handle) continue;

      const permission = await handle.queryPermission({ mode: 'read' });

      if (permission === 'granted') {
        await loadBooksFromHandle(handle, entry.id);
      } else {
        allGranted = false;
      }
    } catch (e) {
      allGranted = false;
    }
  }

  return allGranted;
}

/**
 * Restore chapters from cached blobs in IndexedDB.
 * Returns true if at least one book was restored.
 */
async function restoreFromBlobCache(books) {
  let anyRestored = false;

  for (const book of books) {
    if (loadedChapters.has(book.id)) continue; // already loaded

    try {
      const blobs = await library.getBookBlobs(book.id);
      if (blobs.length > 0) {
        const chapters = blobs.map(b => ({
          name: b.name,
          path: b.path,
          size: b.size,
          lastModified: b.lastModified,
          file: new File([b.blob], b.name, { type: b.blob.type, lastModified: b.lastModified }),
          objectUrl: URL.createObjectURL(b.blob)
        }));
        loadedChapters.set(book.id, chapters);
        anyRestored = true;
      }
    } catch (e) {
      console.warn('Failed to restore blobs for book:', book.title, e);
    }
  }

  return anyRestored;
}

/**
 * Cache audio file blobs to IndexedDB for offline/Android persistence.
 * Shows a progress indicator during the caching process.
 */
async function cacheBooksToBlobs(bookEntries) {
  // bookEntries: Array of { id, chapters }
  // Count total chapters to cache
  let totalChapters = 0;
  const toCache = [];

  for (const entry of bookEntries) {
    const hasCached = await library.hasBookBlobs(entry.id);
    if (!hasCached) {
      toCache.push(entry);
      totalChapters += entry.chapters.length;
    }
  }

  if (totalChapters === 0) return; // everything already cached

  // Show progress UI
  $loadingText.textContent = 'Saving audiobooks for offline use…';
  $loadingProgressContainer.classList.remove('hidden');
  $loadingProgressFill.style.width = '0%';
  $loadingOverlay.classList.remove('hidden');

  let cached = 0;

  for (const entry of toCache) {
    for (let i = 0; i < entry.chapters.length; i++) {
      const ch = entry.chapters[i];
      try {
        // Read file as blob
        const blob = ch.file instanceof File ? ch.file : new Blob([await ch.file.arrayBuffer()]);
        await library.saveChapterBlob(entry.id, i, {
          name: ch.name,
          path: ch.path,
          size: ch.size,
          lastModified: ch.lastModified
        }, blob);
      } catch (e) {
        console.warn('Failed to cache chapter:', ch.name, e);
      }
      cached++;
      const pct = Math.round((cached / totalChapters) * 100);
      $loadingProgressFill.style.width = pct + '%';
      $loadingProgressText.textContent = `${cached} / ${totalChapters} files saved`;

      // Yield to UI thread periodically
      if (cached % 3 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  $loadingOverlay.classList.add('hidden');
  $loadingProgressContainer.classList.add('hidden');
  $loadingText.textContent = 'Loading audiobooks…';
}

/**
 * Load books from a directory handle into memory.
 */
async function loadBooksFromHandle(dirHandle, handleId) {
  const fileEntries = await readDirectoryHandle(dirHandle);
  const books = extractBooks(fileEntries);

  const bookEntries = [];

  for (const book of books) {
    const id = hashId(book.rootFolder + '/' + book.title);
    loadedChapters.set(id, book.chapters);
    bookEntries.push({ id, chapters: book.chapters });

    const existing = await library.getBook(id);
    if (!existing) {
      await library.saveBook({
        id,
        title: book.title,
        rootFolder: book.rootFolder,
        chapterCount: book.chapters.length,
        chapterIndex: 0,
        chapterPosition: 0,
        lastAccessed: Date.now(),
        addedAt: Date.now(),
        handleId: handleId
      });
    } else {
      existing.chapterCount = book.chapters.length;
      if (!existing.handleId) existing.handleId = handleId;
      await library.saveBook(existing);
    }
  }

  // Cache blobs in background for Android/offline persistence
  await cacheBooksToBlobs(bookEntries);
}

/**
 * "Continue Listening" button — grants permission for all handles & loads everything.
 */
$btnContinue.addEventListener('click', async () => {
  let handles;
  try {
    handles = await library.getAllFolderHandles();
  } catch (e) {
    // No handles stored — fall back to folder picker
    triggerFolderPicker();
    return;
  }

  if (!handles || handles.length === 0) {
    triggerFolderPicker();
    return;
  }

  $loadingOverlay.classList.remove('hidden');

  for (const entry of handles) {
    try {
      const handle = entry.handle;
      if (!handle) continue;

      let permission = await handle.queryPermission({ mode: 'read' });
      if (permission !== 'granted') {
        permission = await handle.requestPermission({ mode: 'read' });
      }
      if (permission === 'granted') {
        await loadBooksFromHandle(handle, entry.id);
      }
    } catch (e) {
      console.warn('Could not restore handle:', e);
    }
  }

  $loadingOverlay.classList.add('hidden');
  $continueOverlay.classList.add('hidden');
  needsPermissionGrant = false;

  await renderLibrary();

  // Auto-play last book from saved position
  const lastBookId = await library.getLastBookId();
  if (lastBookId && loadedChapters.has(lastBookId)) {
    await switchToBook(lastBookId, true);
  }
});

init();

// ============================================================
// VIEW MANAGEMENT
// ============================================================

function showLibraryView() {
  currentView = 'library';
  $librarySection.classList.remove('hidden');
  $chaptersSection.classList.add('hidden');
  $bookmarksSection.classList.add('hidden');
  $emptyState.classList.add('hidden');
}

function showChaptersView(bookTitle) {
  currentView = 'chapters';
  $librarySection.classList.add('hidden');
  $chaptersSection.classList.remove('hidden');
  $bookmarksSection.classList.remove('hidden');
  $emptyState.classList.add('hidden');
  $chaptersTitle.textContent = bookTitle;
}

$btnBackLibrary.addEventListener('click', async () => {
  showLibraryView();
  await renderLibrary();
  updateReconnectBanner();
});

/**
 * Show or hide the "Continue Listening" overlay based on whether
 * any stored books still need file-system permission to be re-granted.
 */
function updateReconnectBanner() {
  if (!hasDirectoryPicker) {
    $continueOverlay.classList.add('hidden');
    return;
  }

  // Check if any books in the library are NOT loaded in memory
  library.getAllBooks().then(books => {
    const anyNeedsReconnect = books.some(b => !loadedChapters.has(b.id));
    if (anyNeedsReconnect) {
      needsPermissionGrant = true;
      $continueOverlay.classList.remove('hidden');
    } else {
      needsPermissionGrant = false;
      $continueOverlay.classList.add('hidden');
    }
  });
}

// ============================================================
// FILE LOADING
// ============================================================

async function triggerFolderPicker() {
  if (hasDirectoryPicker) {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      $loadingOverlay.classList.remove('hidden');
      await new Promise(r => setTimeout(r, 50));

      const handleId = 'handle_' + hashId(dirHandle.name);

      // Save handle for future sessions
      await library.saveFolderHandle(handleId, dirHandle);

      // Load books
      await loadBooksFromHandle(dirHandle, handleId);

      $loadingOverlay.classList.add('hidden');
      $emptyState.classList.add('hidden');
      showLibraryView();
      await renderLibrary();
      updateReconnectBanner();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Folder picker error:', e);
      }
      $loadingOverlay.classList.add('hidden');
    }
  } else {
    // Fallback to <input webkitdirectory>
    $folderInput.click();
  }
}

$btnLoadFolder.addEventListener('click', triggerFolderPicker);
$btnLoadEmpty.addEventListener('click', triggerFolderPicker);

// Fallback handler for <input webkitdirectory>
$folderInput.addEventListener('change', async (e) => {
  const fileList = e.target.files;
  if (!fileList || fileList.length === 0) return;

  $loadingOverlay.classList.remove('hidden');
  await new Promise(r => setTimeout(r, 50));

  const books = extractBooks(fileList);

  if (books.length === 0) {
    $loadingOverlay.classList.add('hidden');
    alert('No audio files found in the selected folder.');
    return;
  }

  const bookEntries = [];

  for (const book of books) {
    const id = hashId(book.rootFolder + '/' + book.title);
    loadedChapters.set(id, book.chapters);
    bookEntries.push({ id, chapters: book.chapters });

    const existing = await library.getBook(id);
    if (!existing) {
      await library.saveBook({
        id,
        title: book.title,
        rootFolder: book.rootFolder,
        chapterCount: book.chapters.length,
        chapterIndex: 0,
        chapterPosition: 0,
        lastAccessed: Date.now(),
        addedAt: Date.now()
      });
    } else {
      existing.chapterCount = book.chapters.length;
      existing.lastAccessed = Date.now();
      await library.saveBook(existing);
    }
  }

  $loadingOverlay.classList.add('hidden');
  $emptyState.classList.add('hidden');
  showLibraryView();
  await renderLibrary();
  updateReconnectBanner();
  $folderInput.value = '';

  // Cache blobs in background for Android/offline persistence
  await cacheBooksToBlobs(bookEntries);
});

// ============================================================
// LIBRARY RENDERING
// ============================================================

const COVER_GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
  'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
  'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
  'linear-gradient(135deg, #f5576c 0%, #ff6f61 100%)',
  'linear-gradient(135deg, #0250c5 0%, #d43f8d 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
  'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
  'linear-gradient(135deg, #96fbc4 0%, #f9f586 100%)',
  'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  'linear-gradient(135deg, #667db6 0%, #0082c8 50%, #667db6 100%)',
  'linear-gradient(135deg, #c471f5 0%, #fa71cd 100%)',
];

function getBookGradient(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash) + title.charCodeAt(i);
    hash |= 0;
  }
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
}

async function renderLibrary() {
  const books = await library.getAllBooks();
  $libraryCount.textContent = books.length;
  $libraryList.innerHTML = '';

  if (books.length === 0) {
    $librarySection.classList.add('hidden');
    $emptyState.classList.remove('hidden');
    return;
  }

  for (const book of books) {
    const card = document.createElement('div');
    card.className = 'book-card';
    if (book.id === activeBookId) card.classList.add('active');
    card.dataset.bookId = book.id;

    const isLoaded = loadedChapters.has(book.id);
    const progressPct = book.chapterCount > 0
      ? Math.round(((book.chapterIndex) / book.chapterCount) * 100)
      : 0;

    const gradient = getBookGradient(book.title);

    // Status text
    let statusHtml;
    if (isLoaded) {
      statusHtml = '<span class="dot"></span> Ready';
    } else {
      statusHtml = '⟳ Tap to reconnect';
    }

    card.innerHTML = `
      <div class="book-card-cover">
        <div class="book-card-cover-bg" style="background: ${gradient}"></div>
        <svg class="book-card-cover-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
        <div class="book-card-cover-title">${escapeHtml(book.title)}</div>
      </div>
      <button class="book-card-delete" title="Remove from library" data-book-id="${book.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div class="book-card-body">
        <div class="book-card-title">${escapeHtml(book.title)}</div>
        <div class="book-card-meta">${book.chapterCount} chapter${book.chapterCount !== 1 ? 's' : ''}</div>
        <div class="book-card-progress">
          <div class="book-card-progress-fill" style="width: ${progressPct}%"></div>
        </div>
        <div class="book-card-status">
          ${statusHtml}
          ${book.chapterPosition > 0 ? ` · Ch ${book.chapterIndex + 1} at ${formatTime(book.chapterPosition)}` : ''}
        </div>
      </div>
    `;

    // Click card
    const bookId = book.id;
    const bookTitle = book.title;
    const bookHandleId = book.handleId;

    card.addEventListener('click', async (e) => {
      if (e.target.closest('.book-card-delete')) return;

      // If already loaded — play it
      if (loadedChapters.has(bookId)) {
        await switchToBook(bookId, false);
        return;
      }

      // If has a stored handle — try to request permission (user gesture)
      if (bookHandleId && hasDirectoryPicker) {
        try {
          const handles = await library.getAllFolderHandles();
          const entry = handles.find(h => h.id === bookHandleId);
          if (entry && entry.handle) {
            const perm = await entry.handle.requestPermission({ mode: 'read' });
            if (perm === 'granted') {
              $loadingOverlay.classList.remove('hidden');
              await loadBooksFromHandle(entry.handle, bookHandleId);
              $loadingOverlay.classList.add('hidden');
              await renderLibrary();
              updateReconnectBanner();
              if (loadedChapters.has(bookId)) {
                await switchToBook(bookId, false);
              }
              return;
            }
          }
        } catch (e) {
          console.warn('Handle permission request failed:', e);
        }
      }

      // No handle — shake the card to hint user should use "Reconnect" or "Load Folder"
      card.style.animation = 'none';
      card.offsetHeight; // trigger reflow
      card.style.animation = 'shake 0.4s ease';
    });

    // Delete button
    card.querySelector('.book-card-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Remove "${bookTitle}" from your library?`)) {
        if (activeBookId === bookId) {
          player.pause();
          player.setPlaylist([]);
          activeBookId = null;
          $playerBar.classList.add('hidden');
        }
        loadedChapters.delete(bookId);
        await library.deleteBook(bookId);
        await renderLibrary();
        updateReconnectBanner();
      }
    });

    $libraryList.appendChild(card);
  }
}

// ============================================================
// BOOK SWITCHING
// ============================================================

async function switchToBook(bookId, autoPlay) {
  if (activeBookId && activeBookId !== bookId) {
    await saveCurrentProgress();
  }

  activeBookId = bookId;
  const book = await library.getBook(bookId);
  if (!book) return;

  const chapters = loadedChapters.get(bookId);
  if (!chapters || chapters.length === 0) return;

  const sorted = sortFiles(chapters, currentSort);
  player.setPlaylist(sorted);

  showChaptersView(book.title);
  renderChapterList(sorted);
  await renderBookmarks();

  $playerBar.classList.remove('hidden');

  const chapterIdx = Math.min(book.chapterIndex, sorted.length - 1);
  const position = book.chapterPosition || 0;

  player.playTrack(chapterIdx, position);

  if (!autoPlay) {
    // User clicked
  } else {
    setTimeout(() => {
      player.pause();
    }, 100);
  }

  await library.setLastBook(bookId);
  book.lastAccessed = Date.now();
  await library.saveBook(book);
}

async function saveCurrentProgress() {
  if (!activeBookId) return;
  const track = player.getCurrentTrack();
  if (track && player.currentIndex >= 0) {
    await library.saveProgress(activeBookId, player.currentIndex, player.getCurrentTime());
  }
}

// ============================================================
// CHAPTER LIST RENDERING
// ============================================================

function renderChapterList(chapters) {
  $chapterList.innerHTML = '';
  $chapterCount.textContent = chapters.length;

  chapters.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.index = index;

    if (index === player.currentIndex) {
      li.classList.add('active');
    }

    li.innerHTML = `
      <span class="file-index">${index + 1}</span>
      <div class="file-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <div class="file-details">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-meta">${formatSize(file.size)}</div>
      </div>
      <div class="playing-indicator">
        <span></span><span></span><span></span><span></span>
      </div>
    `;

    li.addEventListener('click', () => {
      player.playTrack(index);
      $playerBar.classList.remove('hidden');
    });

    $chapterList.appendChild(li);
  });
}

// ============================================================
// SORTING
// ============================================================

$sortSelect.addEventListener('change', () => {
  currentSort = $sortSelect.value;
  if (!activeBookId) return;
  const chapters = loadedChapters.get(activeBookId);
  if (!chapters) return;

  const currentTrack = player.getCurrentTrack();
  const sorted = sortFiles(chapters, currentSort);
  player.setPlaylist(sorted);

  if (currentTrack) {
    const newIndex = sorted.findIndex(f => f.path === currentTrack.path);
    if (newIndex >= 0) {
      player.currentIndex = newIndex;
    }
  }

  renderChapterList(sorted);
});

// ============================================================
// PLAYER CONTROLS
// ============================================================

$btnPlay.addEventListener('click', () => player.togglePlay());
$btnPrev.addEventListener('click', () => player.prev());
$btnNext.addEventListener('click', () => player.next());
$btnRewind.addEventListener('click', () => player.skip(-30));
$btnForward.addEventListener('click', () => player.skip(30));

$btnSpeed.addEventListener('click', () => {
  const speed = player.cycleSpeed();
  $speedLabel.textContent = speed + '×';
});

$volumeSlider.addEventListener('input', () => {
  player.setVolume(parseFloat($volumeSlider.value));
});

$btnVolume.addEventListener('click', () => {
  if (player.audio.volume > 0) {
    player.audio._savedVolume = player.audio.volume;
    player.setVolume(0);
    $volumeSlider.value = 0;
  } else {
    const v = player.audio._savedVolume || 1;
    player.setVolume(v);
    $volumeSlider.value = v;
  }
});

// --- Progress bar seeking ---
let isSeeking = false;

$progressBar.addEventListener('mousedown', startSeek);
$progressBar.addEventListener('touchstart', startSeek, { passive: true });

function startSeek(e) {
  isSeeking = true;
  seekFromEvent(e);
  document.addEventListener('mousemove', seekFromEvent);
  document.addEventListener('mouseup', stopSeek);
  document.addEventListener('touchmove', seekFromEvent, { passive: true });
  document.addEventListener('touchend', stopSeek);
}

function stopSeek() {
  isSeeking = false;
  document.removeEventListener('mousemove', seekFromEvent);
  document.removeEventListener('mouseup', stopSeek);
  document.removeEventListener('touchmove', seekFromEvent);
  document.removeEventListener('touchend', stopSeek);
}

function seekFromEvent(e) {
  const rect = $progressBar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  let fraction = (clientX - rect.left) / rect.width;
  fraction = Math.max(0, Math.min(1, fraction));
  player.seekTo(fraction);
  updateProgressUI(fraction * player.getDuration(), player.getDuration());
}

// ============================================================
// PLAYER EVENT CALLBACKS
// ============================================================

player.onTimeUpdate = (currentTime, duration) => {
  if (!isSeeking) {
    updateProgressUI(currentTime, duration);
  }
};

player.onTrackChange = (index, track) => {
  $nowPlayingTitle.textContent = track.name;

  if (activeBookId) {
    library.getBook(activeBookId).then(book => {
      if (book) {
        $nowPlayingBook.textContent = book.title;
        player.setMediaMetadata(track.name, book.title, book.title);
      }
    });
  }

  document.querySelectorAll('.file-item').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
};

player.onPlayStateChange = (playing) => {
  $iconPlay.classList.toggle('hidden', playing);
  $iconPause.classList.toggle('hidden', !playing);

  if (playing && activeBookId) {
    bookmarks.startAutoSave(() => {
      const track = player.getCurrentTrack();
      if (!track || !activeBookId) return null;
      return {
        bookId: activeBookId,
        chapterIndex: player.currentIndex,
        position: player.getCurrentTime()
      };
    }, library);
  } else {
    saveCurrentProgress();
    bookmarks.stopAutoSave();
  }
};

function updateProgressUI(current, duration) {
  $timeCurrent.textContent = formatTime(current);
  $timeTotal.textContent = formatTime(duration);

  if (duration > 0) {
    const pct = (current / duration) * 100;
    $progressFill.style.width = pct + '%';
    $progressThumb.style.left = pct + '%';
  }
}

// ============================================================
// BOOKMARKS
// ============================================================

$btnAddBookmark.addEventListener('click', async () => {
  const track = player.getCurrentTrack();
  if (!track || !activeBookId) return;

  const position = player.getCurrentTime();
  await bookmarks.add(activeBookId, track.name, player.currentIndex, position);
  await renderBookmarks();

  $btnAddBookmark.style.transform = 'scale(1.2)';
  setTimeout(() => { $btnAddBookmark.style.transform = ''; }, 200);
});

async function renderBookmarks() {
  if (!activeBookId) return;
  const bms = await bookmarks.getAll(activeBookId);
  $bookmarkCount.textContent = bms.length;
  $noBookmarks.classList.toggle('hidden', bms.length > 0);
  $bookmarkList.innerHTML = '';

  bms.forEach(bm => {
    const li = document.createElement('li');
    li.className = 'bookmark-item';

    li.innerHTML = `
      <div class="bm-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="bm-details">
        <div class="bm-name">${escapeHtml(bm.label)}</div>
        <div class="bm-meta">Ch ${bm.chapterIndex + 1} · ${formatTime(bm.position)}</div>
      </div>
      <button class="bm-delete" title="Delete bookmark" data-id="${bm.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.bm-delete')) return;
      player.playTrack(bm.chapterIndex, bm.position);
      $playerBar.classList.remove('hidden');
    });

    li.querySelector('.bm-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await bookmarks.delete(bm.id);
      await renderBookmarks();
    });

    $bookmarkList.appendChild(li);
  });
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      player.togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      player.skip(-10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      player.skip(10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      player.setVolume(player.audio.volume + 0.05);
      $volumeSlider.value = player.audio.volume;
      break;
    case 'ArrowDown':
      e.preventDefault();
      player.setVolume(player.audio.volume - 0.05);
      $volumeSlider.value = player.audio.volume;
      break;
  }
});

// ============================================================
// SAVE PROGRESS BEFORE CLOSING
// ============================================================

window.addEventListener('beforeunload', () => {
  saveCurrentProgress();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveCurrentProgress();
  }
});

// ============================================================
// ABOUT MODAL
// ============================================================

$btnAbout.addEventListener('click', () => {
  $aboutModal.classList.remove('hidden');
});

$aboutClose.addEventListener('click', () => {
  $aboutModal.classList.add('hidden');
});

$aboutModal.addEventListener('click', (e) => {
  if (e.target === $aboutModal) {
    $aboutModal.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$aboutModal.classList.contains('hidden')) {
    $aboutModal.classList.add('hidden');
  }
});

// ============================================================
// UTILS
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// SERVICE WORKER REGISTRATION
// ============================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { });
  });
}
