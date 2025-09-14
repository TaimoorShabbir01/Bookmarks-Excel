// Collapsible folder tree + CSV/XLSX export of bookmarks within the selected folder.

const treeEl = document.getElementById('tree');
const btnCsv = document.getElementById('exportCsv');
const btnXlsx = document.getElementById('exportXlsx');
const btnExpandAll = document.getElementById('expandAll');
const btnCollapseAll = document.getElementById('collapseAll');

let selectedFolderId = null;
let expanded = new Set(); // persisted via chrome.storage.local

// --------- Persistence helpers ---------
async function loadExpanded() {
  try {
    const data = await chrome.storage?.local.get(['expandedFolders']);
    if (data && Array.isArray(data.expandedFolders)) expanded = new Set(data.expandedFolders);
  } catch {}
}
async function saveExpanded() {
  try { await chrome.storage?.local.set({ expandedFolders: [...expanded] }); } catch {}
}

// --------- Tree rendering ---------
function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rowsToCsv(rows) {
  const headers = ['Title', 'URL', 'DateAdded', 'FolderPath'];
  const esc = (s) => {
    const t = String(s ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// Recursively collect bookmarks under a folder node
function collectBookmarksFromSubtree(subtreeRoot, parentPath = []) {
  const rows = [];
  const thisPath = parentPath.concat(subtreeRoot.title || '');
  if (subtreeRoot.children && subtreeRoot.children.length) {
    for (const child of subtreeRoot.children) {
      if (child.url) {
        rows.push({
          Title: child.title || '',
          URL: child.url || '',
          DateAdded: formatDate(child.dateAdded),
          FolderPath: thisPath.join(' / ')
        });
      } else {
        rows.push(...collectBookmarksFromSubtree(child, thisPath));
      }
    }
  }
  return rows;
}

async function getFolderRows(folderId) {
  const subtree = await chrome.bookmarks.getSubTree(folderId);
  if (!subtree || !subtree[0]) return [];
  return collectBookmarksFromSubtree(subtree[0], []);
}

function makeFolderLine(node) {
  const line = document.createElement('div');
  line.className = 'folderline';

  const twisty = document.createElement('div');
  twisty.className = 'twisty';
  twisty.textContent = expanded.has(node.id) ? '▾' : '▸';

  const label = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'folder';
  radio.value = node.id;
  radio.addEventListener('change', () => (selectedFolderId = node.id));
  label.appendChild(radio);
  label.appendChild(document.createTextNode(' 📁 ' + (node.title || '(unnamed folder)')));

  // Toggle expand/collapse
  twisty.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = expanded.has(node.id);
    if (open) expanded.delete(node.id); else expanded.add(node.id);
    saveExpanded();
    const kids = line.parentElement.querySelector(':scope > ul.children');
    if (kids) kids.style.display = open ? 'none' : '';
    twisty.textContent = open ? '▸' : '▾';
  });

  line.appendChild(twisty);
  line.appendChild(label);
  return { line, twisty };
}

function renderTree(nodes, container) {
  const ul = document.createElement('ul');
  for (const n of nodes) {
    const li = document.createElement('li');

    if (!n.url) {
      // Folder
      const { line, twisty } = makeFolderLine(n);
      li.appendChild(line);

      // Children container
      if (n.children && n.children.length) {
        const childUl = document.createElement('ul');
        childUl.className = 'children';
        childUl.style.display = expanded.has(n.id) ? '' : 'none';
        renderTree(n.children, childUl);
        li.appendChild(childUl);
      } else {
        // no children -> hide the toggle control
        twisty.classList.add('empty');
      }
    } else {
      // Link (non-selectable)
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = ' 🔗 ' + (n.title || n.url);
      li.appendChild(span);
    }

    ul.appendChild(li);
  }
  container.appendChild(ul);
}

async function initTree() {
  await loadExpanded();
  const roots = await chrome.bookmarks.getTree();
  treeEl.innerHTML = '';
  renderTree(roots, treeEl);
}

// --------- Export handlers ----------
async function handleExportCsv() {
  if (!selectedFolderId) return alert('Please select a folder first.');
  const rows = await getFolderRows(selectedFolderId);
  if (!rows.length) return alert('No links found in that folder.');
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  downloadBlob(`bookmarks-${stamp}.csv`, blob);
}

async function handleExportXlsx() {
  if (typeof XLSX === 'undefined') {
    alert('XLSX library not found.\nUse CSV or add xlsx.full.min.js next to popup.html.');
    return;
  }
  if (!selectedFolderId) return alert('Please select a folder first.');
  const rows = await getFolderRows(selectedFolderId);
  if (!rows.length) return alert('No links found in that folder.');
  const ws = XLSX.utils.json_to_sheet(rows, { header: ['Title','URL','DateAdded','FolderPath'] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bookmarks');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  downloadBlob(`bookmarks-${stamp}.xlsx`, blob);
}

// --------- Expand/Collapse all ----------
function setAll(open) {
  // Flip state for all twisties & children lists currently in DOM
  const allTwisties = treeEl.querySelectorAll('.twisty:not(.empty)');
  const allChildren = treeEl.querySelectorAll('ul.children');
  allTwisties.forEach(t => t.textContent = open ? '▾' : '▸');
  allChildren.forEach(ul => ul.style.display = open ? '' : 'none');

  // Track all folder ids visible in DOM
  const radios = treeEl.querySelectorAll('input[type="radio"][name="folder"]');
  const ids = [...radios].map(r => r.value);
  expanded = open ? new Set(ids) : new Set();
  saveExpanded();
}

// --------- Wire up ----------
btnCsv.addEventListener('click', handleExportCsv);
btnXlsx.addEventListener('click', handleExportXlsx);
btnExpandAll.addEventListener('click', () => setAll(true));
btnCollapseAll.addEventListener('click', () => setAll(false));

initTree();
