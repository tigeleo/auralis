/**
 * File Loader Module
 * Handles loading audio files from FileList or directory handles,
 * grouping into books by subfolder, and sorting.
 */

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'ogg', 'wav', 'flac', 'aac', 'opus', 'wma', 'webm'
]);

/**
 * @typedef {Object} AudioFile
 * @property {string} name
 * @property {string} path - relative path
 * @property {number} size
 * @property {number} lastModified
 * @property {File} file
 * @property {string} objectUrl
 */

/**
 * @typedef {Object} Book
 * @property {string} title
 * @property {string} rootFolder
 * @property {AudioFile[]} chapters
 */

/**
 * Natural compare — sorts numbers numerically within strings.
 */
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];

  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aIsNum = /^\d+$/.test(aParts[i]);
    const bIsNum = /^\d+$/.test(bParts[i]);

    if (aIsNum && bIsNum) {
      const diff = parseInt(aParts[i], 10) - parseInt(bParts[i], 10);
      if (diff !== 0) return diff;
    } else {
      const cmp = aParts[i].toLowerCase().localeCompare(bParts[i].toLowerCase());
      if (cmp !== 0) return cmp;
    }
  }

  return aParts.length - bParts.length;
}

/**
 * Read all files from a FileSystemDirectoryHandle recursively.
 * Returns an array of { file: File, path: string } objects.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<Array<{file: File, path: string}>>}
 */
export async function readDirectoryHandle(dirHandle) {
  const results = [];
  const rootName = dirHandle.name;

  async function traverse(handle, currentPath) {
    for await (const entry of handle.values()) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        try {
          const file = await entry.getFile();
          results.push({ file, path: entryPath });
        } catch (e) {
          // skip unreadable files
        }
      } else if (entry.kind === 'directory') {
        await traverse(entry, entryPath);
      }
    }
  }

  await traverse(dirHandle, rootName);
  return results;
}

export function extractBooks(input) {
  const bookMap = new Map();
  let rootFolderName = '';

  // Normalize input to iterable of { file, path }
  const items = Array.from(input).map(item => {
    if (item instanceof File) {
      // On some mobile devices (Android Chrome), webkitRelativePath is empty.
      // We fall back to item.name, meaning it will sit in the root.
      const path = item.webkitRelativePath || item.name;
      return { file: item, path: path };
    }
    return item; // already { file, path }
  });

  for (const { file, path } of items) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) continue;

    // Split by slash and remove any empty string segments
    const parts = path.split('/').filter(Boolean);

    // If there's only 1 part, it's just the file name (no hierarchy).
    let bookTitle;
    if (parts.length === 1) {
       bookTitle = 'Audiobook';
    } else {
       // First part is usually the top-level directory selected by the user.
       if (!rootFolderName) {
         rootFolderName = parts[0];
       }
       
       if (parts.length === 2) {
         // e.g. "MyBook/01.mp3" -> book title is "MyBook"
         bookTitle = parts[0];
       } else {
         // e.g. "Library/MyBook/01.mp3" -> book title is "MyBook"
         bookTitle = parts[1];
       }
    }

    if (!bookMap.has(bookTitle)) {
      bookMap.set(bookTitle, []);
    }

    bookMap.get(bookTitle).push({
      name: file.name,
      path: path,
      size: file.size,
      lastModified: file.lastModified,
      file: file,
      objectUrl: URL.createObjectURL(file)
    });
  }

  const books = [];
  for (const [title, chapters] of bookMap) {
    chapters.sort((a, b) => naturalCompare(a.path, b.path));
    books.push({
      title,
      rootFolder: rootFolderName,
      chapters
    });
  }

  books.sort((a, b) => naturalCompare(a.title, b.title));
  return books;
}

/**
 * Sort chapters.
 */
export function sortFiles(files, sortKey) {
  const copy = [...files];
  switch (sortKey) {
    case 'natural':
      copy.sort((a, b) => naturalCompare(a.path, b.path));
      break;
    case 'name-asc':
      copy.sort((a, b) => naturalCompare(a.name, b.name));
      break;
    case 'name-desc':
      copy.sort((a, b) => naturalCompare(b.name, a.name));
      break;
    default:
      copy.sort((a, b) => naturalCompare(a.path, b.path));
  }
  return copy;
}

/**
 * Format bytes to a human-readable string.
 */
export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}
