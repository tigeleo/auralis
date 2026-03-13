/**
 * Bookmark & Library System
 * Manages bookmarks, per-book progress, library persistence, and folder handles via IndexedDB.
 */

const DB_NAME = 'audiobookPlayerDB';
const DB_VERSION = 4;
const STORE_BOOKMARKS = 'bookmarks';
const STORE_LIBRARY = 'library';
const STORE_STATE = 'appState';
const STORE_FOLDERS = 'folders';
const STORE_AUDIO_BLOBS = 'audioBlobs';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
        db.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        db.createObjectStore(STORE_LIBRARY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO_BLOBS)) {
        const blobStore = db.createObjectStore(STORE_AUDIO_BLOBS, { keyPath: 'id' });
        blobStore.createIndex('bookId', 'bookId', { unique: false });
      }
      if (db.objectStoreNames.contains('autosave')) {
        db.deleteObjectStore('autosave');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// LIBRARY
// ============================================================

export class LibraryManager {
  async getAllBooks() {
    const books = await dbGetAll(STORE_LIBRARY);
    books.sort((a, b) => b.lastAccessed - a.lastAccessed);
    return books;
  }

  async getBook(id) {
    return dbGet(STORE_LIBRARY, id);
  }

  async saveBook(book) {
    await dbPut(STORE_LIBRARY, book);
  }

  async deleteBook(id) {
    await dbDelete(STORE_LIBRARY, id);
    // Delete bookmarks for this book
    const allBm = await dbGetAll(STORE_BOOKMARKS);
    for (const bm of allBm) {
      if (bm.bookId === id) {
        await dbDelete(STORE_BOOKMARKS, bm.id);
      }
    }
    // Delete cached audio blobs for this book
    await this.deleteBookBlobs(id);
  }

  async saveProgress(bookId, chapterIndex, position) {
    const book = await this.getBook(bookId);
    if (book) {
      book.chapterIndex = chapterIndex;
      book.chapterPosition = position;
      book.lastAccessed = Date.now();
      await this.saveBook(book);
    }
  }

  async setLastBook(bookId) {
    await dbPut(STORE_STATE, { key: 'lastBookId', value: bookId });
  }

  async getLastBookId() {
    const entry = await dbGet(STORE_STATE, 'lastBookId');
    return entry ? entry.value : null;
  }

  // --- Folder Handles (File System Access API) ---

  /**
   * Save a directory handle for persistent access.
   * @param {string} id - unique ID for this folder
   * @param {FileSystemDirectoryHandle} handle
   */
  async saveFolderHandle(id, handle) {
    await dbPut(STORE_FOLDERS, { id, handle });
  }

  /**
   * Get all stored folder handles.
   * @returns {Promise<Array<{id: string, handle: FileSystemDirectoryHandle}>>}
   */
  async getAllFolderHandles() {
    return dbGetAll(STORE_FOLDERS);
  }

  /**
   * Delete a folder handle.
   * @param {string} id
   */
  async deleteFolderHandle(id) {
    await dbDelete(STORE_FOLDERS, id);
  }

  // --- Audio Blob Cache (for Android / no File System Access API) ---

  /**
   * Save a single chapter's audio blob to IndexedDB.
   * @param {string} bookId
   * @param {number} chapterIndex
   * @param {Object} chapterMeta - { name, path, size, lastModified }
   * @param {Blob} blob
   */
  async saveChapterBlob(bookId, chapterIndex, chapterMeta, blob) {
    await dbPut(STORE_AUDIO_BLOBS, {
      id: `${bookId}_ch${chapterIndex}`,
      bookId,
      chapterIndex,
      name: chapterMeta.name,
      path: chapterMeta.path,
      size: chapterMeta.size,
      lastModified: chapterMeta.lastModified,
      blob
    });
  }

  /**
   * Get all cached chapter blobs for a book, sorted by chapterIndex.
   * @param {string} bookId
   * @returns {Promise<Array>} Array of { chapterIndex, name, path, size, lastModified, blob }
   */
  async getBookBlobs(bookId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO_BLOBS, 'readonly');
      const store = tx.objectStore(STORE_AUDIO_BLOBS);
      const index = store.index('bookId');
      const req = index.getAll(bookId);
      req.onsuccess = () => {
        const results = req.result || [];
        results.sort((a, b) => a.chapterIndex - b.chapterIndex);
        resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Check if a book has cached blobs.
   * @param {string} bookId
   * @returns {Promise<boolean>}
   */
  async hasBookBlobs(bookId) {
    const blobs = await this.getBookBlobs(bookId);
    return blobs.length > 0;
  }

  /**
   * Delete all cached blobs for a book.
   * @param {string} bookId
   */
  async deleteBookBlobs(bookId) {
    const blobs = await this.getBookBlobs(bookId);
    for (const blob of blobs) {
      await dbDelete(STORE_AUDIO_BLOBS, blob.id);
    }
  }
}

// ============================================================
// BOOKMARKS
// ============================================================

export class BookmarkManager {
  constructor() {
    this._autoSaveTimer = null;
  }

  async getAll(bookId) {
    let bms = await dbGetAll(STORE_BOOKMARKS);
    if (bookId) bms = bms.filter(b => b.bookId === bookId);
    bms.sort((a, b) => b.createdAt - a.createdAt);
    return bms;
  }

  async add(bookId, trackName, chapterIndex, position, label) {
    const bookmark = {
      id: 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      bookId,
      trackName,
      chapterIndex,
      position,
      createdAt: Date.now(),
      label: label || `${trackName} @ ${formatTime(position)}`
    };
    await dbPut(STORE_BOOKMARKS, bookmark);
    return bookmark;
  }

  async delete(id) {
    await dbDelete(STORE_BOOKMARKS, id);
  }

  startAutoSave(getState, library) {
    this.stopAutoSave();
    this._autoSaveTimer = setInterval(async () => {
      const state = getState();
      if (state && state.position > 0) {
        await library.saveProgress(state.bookId, state.chapterIndex, state.position);
        await library.setLastBook(state.bookId);
      }
    }, 5000);
  }

  stopAutoSave() {
    if (this._autoSaveTimer) {
      clearInterval(this._autoSaveTimer);
      this._autoSaveTimer = null;
    }
  }
}

// ============================================================
// UTILS
// ============================================================

export function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function hashId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return 'book_' + Math.abs(hash).toString(36);
}
