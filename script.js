const STORAGE_KEY = 'shop-ledger-sections-v1';

  // ---- Firebase (cross-device sync) ----
  const firebaseConfig = {
    apiKey: "AIzaSyCvwxEkhQtduVr9W0uMSPIbqHziHrFJJKg",
    authDomain: "gp-care-ledger.firebaseapp.com",
    databaseURL: "https://gp-care-ledger-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "gp-care-ledger",
    storageBucket: "gp-care-ledger.firebasestorage.app",
    messagingSenderId: "1097167603389",
    appId: "1:1097167603389:web:2266035c0aaf468ca859d4"
  };
  firebase.initializeApp(firebaseConfig);
  const fbAuth = firebase.auth();
  const fbDb = firebase.database();
  const ledgerRef = fbDb.ref('ledgerData');

  let lastSyncedJSON = null;   // last JSON we either wrote or received — used to ignore our own echo
  let fbWriteTimer = null;
  let fbReady = false;         // becomes true once the first Firebase sync round-trip completes
  let pendingRemoteRender = false; // true when a remote update arrived while the user was typing

  function setSyncStatus(state){
    const el = document.getElementById('syncStatus');
    if(!el) return;
    el.classList.remove('synced', 'syncing', 'offline');
    if(state === 'synced'){ el.textContent = '✅ সব ডিভাইসে সিঙ্ক আছে'; el.classList.add('synced'); }
    else if(state === 'syncing'){ el.textContent = '🔄 সিঙ্ক হচ্ছে...'; el.classList.add('syncing'); }
    else if(state === 'offline'){ el.textContent = '⚠️ অফলাইন — শুধু এই ডিভাইসে সেভ হচ্ছে'; el.classList.add('offline'); }
  }

  function loadSections(){
    try{
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return normalizeSections(saved);
    }catch(e){
      return [];
    }
  }

  // makes sure every section/row has the fields the app expects, even if the
  // saved data is old, partial, or came back from Firebase in an unexpected shape —
  // prevents the whole app from crashing on one bad entry.
  function normalizeSections(arr){
    if(!Array.isArray(arr)) return [];
    return arr.map(s => {
      if(!s || typeof s !== 'object') return null;
      const rows = Array.isArray(s.rows) ? s.rows : [];
      return {
        id: s.id || genId(),
        date: s.date || '',
        balance: s.balance || '',
        rows: rows.length ? rows.map(r => ({
          simType: (r && r.simType) || '',
          number: (r && r.number) || '',
          price: (r && r.price) || '',
          replacementNumber: (r && r.replacementNumber) || '',
          replacementPrice: (r && r.replacementPrice) || '',
          plType: (r && r.plType) || '',
          plNumber: (r && r.plNumber) || '',
          plPrice: (r && r.plPrice) || ''
        })) : [emptyRow()],
        totalTaka: s.totalTaka || '',
        closingBalance: s.closingBalance || ''
      };
    }).filter(Boolean);
  }

  function saveSections(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(sections)); }
    catch(e){}

    if(!fbReady) return; // don't push to the cloud until the initial sync has settled
    clearTimeout(fbWriteTimer);
    setSyncStatus('syncing');
    fbWriteTimer = setTimeout(() => {
      const json = JSON.stringify(sections);
      lastSyncedJSON = json;
      ledgerRef.set(sections)
        .then(() => setSyncStatus('synced'))
        .catch(() => setSyncStatus('offline'));
    }, 600);
  }

  function initCloudSync(){
    fbAuth.signInAnonymously().catch(() => setSyncStatus('offline'));

    fbAuth.onAuthStateChanged((user) => {
      if(!user) return;

      ledgerRef.on('value', (snapshot) => {
        const remote = snapshot.val();

        if(remote === null){
          // nothing in the cloud yet — push whatever this device already has (from localStorage)
          fbReady = true;
          lastSyncedJSON = JSON.stringify(sections);
          ledgerRef.set(sections).then(() => setSyncStatus('synced')).catch(() => setSyncStatus('offline'));
          if(sections.length === 0) addSection();
          return;
        }

        const remoteJSON = JSON.stringify(remote);
        fbReady = true;
        if(remoteJSON === lastSyncedJSON){
          setSyncStatus('synced');
          return; // this is just our own write echoing back — nothing to re-render
        }

        lastSyncedJSON = remoteJSON;
        sections = normalizeSections(remote);
        if(isTypingActive()){
          pendingRemoteRender = true; // apply once the user leaves the field they're editing
        } else {
          renderAll();
        }
        setSyncStatus('synced');
      }, () => setSyncStatus('offline'));
    });
  }

  function isTypingActive(){
    const el = document.activeElement;
    return !!(el && el.tagName === 'INPUT' && wrap.contains(el));
  }

  function genId(){
    return 'sec-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function todayStr(){
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function emptyRow(){
    return { simType:'', number:'', price:'', replacementNumber:'', replacementPrice:'', plType:'', plNumber:'', plPrice:'' };
  }

  const FIELD_ORDER = ['simType', 'number', 'price', 'replacementNumber', 'replacementPrice', 'plType', 'plNumber', 'plPrice'];

  function newSection(){
    return { id: genId(), date: todayStr(), balance: '', rows: [emptyRow()], totalTaka: '', closingBalance: '' };
  }

  function parseNum(str){
    if(str === null || str === undefined) return 0;
    const cleaned = String(str).replace(/[^0-9.\-]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
  }

  function bdt(n){
    return "৳" + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function escapeAttr(v){
    return String(v ?? '').replace(/"/g, '&quot;');
  }

  let sections = loadSections();
  let activeSearchDate = null;

  const wrap = document.getElementById('sectionsWrap');
  const emptyState = document.getElementById('emptyState');
  const template = document.getElementById('sectionTemplate');

  // once the user leaves the field they were editing, apply any remote update
  // that arrived while they were typing (so it never yanks focus mid-keystroke)
  wrap.addEventListener('focusout', () => {
    setTimeout(() => {
      if(pendingRemoteRender && !isTypingActive()){
        pendingRemoteRender = false;
        renderAll();
      }
    }, 80);
  });

  function rowHTML(sectionId, row, idx){
    return `
      <tr>
        <td class="sl-cell">${idx + 1}</td>
        <td><input type="text" value="${escapeAttr(row.simType)}" data-section="${sectionId}" data-idx="${idx}" data-field="simType" placeholder="sim name"></td>
        <td><input type="text" value="${escapeAttr(row.number)}" data-section="${sectionId}" data-idx="${idx}" data-field="number" placeholder="sim number"></td>
        <td><input type="text" inputmode="decimal" class="num-input" value="${escapeAttr(row.price)}" data-section="${sectionId}" data-idx="${idx}" data-field="price" placeholder="০"></td>
        <td><input type="text" value="${escapeAttr(row.replacementNumber)}" data-section="${sectionId}" data-idx="${idx}" data-field="replacementNumber" placeholder="replace number"></td>
        <td><input type="text" inputmode="decimal" class="num-input" value="${escapeAttr(row.replacementPrice)}" data-section="${sectionId}" data-idx="${idx}" data-field="replacementPrice" placeholder="০"></td>
        <td><input type="text" value="${escapeAttr(row.plType)}" data-section="${sectionId}" data-idx="${idx}" data-field="plType" placeholder="PL type"></td>
        <td><input type="text" value="${escapeAttr(row.plNumber)}" data-section="${sectionId}" data-idx="${idx}" data-field="plNumber" placeholder="PL number"></td>
        <td><input type="text" inputmode="decimal" class="num-input" value="${escapeAttr(row.plPrice)}" data-section="${sectionId}" data-idx="${idx}" data-field="plPrice" placeholder="০"></td>
        <td><button class="row-delete" data-idx="${idx}" aria-label="এই এন্ট্রি মুছুন">×</button></td>
      </tr>
    `;
  }

  function updateSectionTotals(el, section){
    const totalPrice = section.rows.reduce((sum, r) => sum + parseNum(r.price), 0);
    const totalReplacementPrice = section.rows.reduce((sum, r) => sum + parseNum(r.replacementPrice), 0);
    const totalPl = section.rows.reduce((sum, r) => sum + parseNum(r.plPrice), 0);
    el.querySelector('[data-role="total-price"]').textContent = bdt(totalPrice);
    el.querySelector('[data-role="total-replacementprice"]').textContent = bdt(totalReplacementPrice);
    el.querySelector('[data-role="total-plprice"]').textContent = bdt(totalPl);

    const totalTaka = totalPrice + totalReplacementPrice + totalPl;
    section.totalTaka = String(totalTaka);
    el.querySelector('[data-role="totalTaka"]').value = totalTaka.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function renderSectionElement(section){
    const frag = template.content.cloneNode(true);
    const el = frag.querySelector('.date-section');
    el.dataset.sectionId = section.id;
    el.querySelector('[data-role="date"]').value = section.date || '';
    el.querySelector('[data-role="balance"]').value = section.balance || '';
    el.querySelector('[data-role="closingBalance"]').value = section.closingBalance || '';
    const tbody = el.querySelector('[data-role="rows-body"]');
    tbody.innerHTML = section.rows.map((row, idx) => rowHTML(section.id, row, idx)).join('');
    updateSectionTotals(el, section);
    return el;
  }

  function renderAll(){
    const list = activeSearchDate ? sections.filter(s => s.date === activeSearchDate) : sections;

    if(sections.length === 0){
      wrap.innerHTML = '';
      emptyState.style.display = 'block';
      updateSearchUI();
      return;
    }
    emptyState.style.display = 'none';

    if(activeSearchDate && list.length === 0){
      wrap.innerHTML = '';
      updateSearchUI();
      return;
    }

    wrap.innerHTML = '';
    list.forEach(section => wrap.appendChild(renderSectionElement(section)));
    updateSearchUI();
  }

  function formatDateDisplay(iso){
    if(!iso) return '';
    const parts = iso.split('-');
    if(parts.length !== 3) return iso;
    const [y, m, d] = parts;
    return `${d}-${m}-${y}`;
  }

  function updateSearchUI(){
    const msg = document.getElementById('searchMessage');
    const clearBtn = document.getElementById('clearSearchBtn');
    if(!activeSearchDate){
      clearBtn.style.display = 'none';
      msg.style.display = 'none';
      return;
    }
    clearBtn.style.display = 'inline-flex';
    const matches = sections.filter(s => s.date === activeSearchDate);
    msg.style.display = 'block';
    msg.textContent = matches.length === 0
      ? `"${formatDateDisplay(activeSearchDate)}" তারিখে কোনো হিসাব পাওয়া যায়নি।`
      : `"${formatDateDisplay(activeSearchDate)}" তারিখের হিসাব দেখানো হচ্ছে (${matches.length}টি)।`;
  }

  function performSearch(){
    const val = document.getElementById('searchDateInput').value;
    if(!val) return;
    activeSearchDate = val;
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearSearch(){
    activeSearchDate = null;
    document.getElementById('searchDateInput').value = '';
    renderAll();
  }

  function addSection(){
    activeSearchDate = null;
    document.getElementById('searchDateInput').value = '';
    const section = newSection();
    sections.push(section);
    saveSections();
    renderAll();
    const el = wrap.querySelector(`[data-section-id="${section.id}"]`);
    if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function insertSectionAfter(id){
    activeSearchDate = null;
    document.getElementById('searchDateInput').value = '';
    const idx = sections.findIndex(s => s.id === id);
    const section = newSection();
    if(idx === -1){
      sections.push(section);
    } else {
      sections.splice(idx + 1, 0, section);
    }
    saveSections();
    renderAll();
    const el = wrap.querySelector(`[data-section-id="${section.id}"]`);
    if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function deleteSection(id){
    const section = sections.find(s => s.id === id);
    if(!section) return;
    const label = section.date || 'এই তারিখ';
    if(!window.confirm(`"${label}" এর পুরো হিসাব মুছে ফেলতে চান? এই কাজটি ফিরিয়ে নেওয়া যাবে না।`)) return;
    sections = sections.filter(s => s.id !== id);
    saveSections();
    renderAll();
  }

  function addRowToSection(id){
    const section = sections.find(s => s.id === id);
    if(!section) return;
    section.rows.push(emptyRow());
    saveSections();
    renderAll();
    const el = wrap.querySelector(`[data-section-id="${id}"]`);
    if(el){
      const inputs = el.querySelectorAll('tbody tr:last-child input');
      if(inputs.length) inputs[0].focus();
    }
  }

  function deleteRow(sectionId, idx){
    const section = sections.find(s => s.id === sectionId);
    if(!section) return;
    section.rows.splice(idx, 1);
    saveSections();
    renderAll();
  }

  function clearAll(){
    if(sections.length === 0) return;
    if(!window.confirm('সব তারিখের সব হিসাব মুছে ফেলতে চান? এই কাজটি ফিরিয়ে নেওয়া যাবে না।')) return;
    sections = [];
    saveSections();
    renderAll();
  }

  // ---- backup: export current data as a JSON file, or import a previously exported file ----
  function exportData(){
    const dataStr = JSON.stringify(sections, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shop-ledger-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importData(file){
    const reader = new FileReader();
    reader.onload = (e) => {
      let parsed;
      try{
        parsed = JSON.parse(e.target.result);
      }catch(err){
        window.alert('ফাইলটি পড়া যায়নি। এটা কি সঠিক ব্যাকআপ (.json) ফাইল?');
        return;
      }
      if(!Array.isArray(parsed)){
        window.alert('ফাইলের ফরম্যাট ঠিক নেই। এটা কি এই অ্যাপ থেকেই এক্সপোর্ট করা ফাইল?');
        return;
      }
      if(!window.confirm(`এই ফাইল থেকে ${parsed.length}টি তারিখের হিসাব ইমপোর্ট করতে চান?\nবর্তমান সব ডেটা মুছে গিয়ে এটা দিয়ে প্রতিস্থাপিত হবে।`)) return;

      sections = parsed;
      activeSearchDate = null;
      document.getElementById('searchDateInput').value = '';
      saveSections();
      renderAll();
      window.alert('সফলভাবে ইমপোর্ট হয়েছে।');
    };
    reader.readAsText(file);
  }

  // typing — update the model and (for price fields) the section total,
  // without a full re-render, so the field never loses focus
  wrap.addEventListener('input', (e) => {
    const sectionEl = e.target.closest('.date-section');
    if(!sectionEl) return;
    const section = sections.find(s => s.id === sectionEl.dataset.sectionId);
    if(!section) return;

    const role = e.target.dataset.role;
    if(role === 'date'){ section.date = e.target.value; saveSections(); return; }
    if(role === 'balance'){ section.balance = e.target.value; saveSections(); return; }
    if(role === 'closingBalance'){ section.closingBalance = e.target.value; saveSections(); return; }

    const field = e.target.dataset.field;
    const idx = e.target.dataset.idx;
    if(field !== undefined && idx !== undefined && section.rows[idx]){
      section.rows[idx][field] = e.target.value;
      saveSections();
      if(field === 'price' || field === 'replacementPrice' || field === 'plPrice') updateSectionTotals(sectionEl, section);
    }
  });

  // pressing Enter in a row field jumps to the next field — like Tab, for fast data entry.
  // Enter on the last field (PL price) adds a new row and focuses its first field.
  wrap.addEventListener('keydown', (e) => {
    if(e.key !== 'Enter') return;
    const field = e.target.dataset.field;
    if(field === undefined) return;
    e.preventDefault();

    const sectionEl = e.target.closest('.date-section');
    if(!sectionEl) return;
    const idx = e.target.dataset.idx;
    const pos = FIELD_ORDER.indexOf(field);

    if(pos > -1 && pos < FIELD_ORDER.length - 1){
      const nextField = FIELD_ORDER[pos + 1];
      const nextInput = sectionEl.querySelector(`[data-idx="${idx}"][data-field="${nextField}"]`);
      if(nextInput) nextInput.focus();
    } else {
      addRowToSection(sectionEl.dataset.sectionId);
    }
  });

  wrap.addEventListener('click', (e) => {
    const addRowBtn = e.target.closest('[data-role="add-row"]');
    if(addRowBtn){
      const sectionEl = addRowBtn.closest('.date-section');
      addRowToSection(sectionEl.dataset.sectionId);
      return;
    }
    const addSectionBtn = e.target.closest('[data-role="add-section"]');
    if(addSectionBtn){
      const sectionEl = addSectionBtn.closest('.date-section');
      insertSectionAfter(sectionEl.dataset.sectionId);
      return;
    }
    const delSectionBtn = e.target.closest('[data-role="delete-section"]');
    if(delSectionBtn){
      const sectionEl = delSectionBtn.closest('.date-section');
      deleteSection(sectionEl.dataset.sectionId);
      return;
    }
    const delRowBtn = e.target.closest('.row-delete');
    if(delRowBtn){
      const sectionEl = delRowBtn.closest('.date-section');
      deleteRow(sectionEl.dataset.sectionId, parseInt(delRowBtn.dataset.idx, 10));
      return;
    }
  });

  document.getElementById('addDateBtn').addEventListener('click', addSection);
  document.getElementById('emptyAddBtn').addEventListener('click', addSection);
  document.getElementById('clearAllBtn').addEventListener('click', clearAll);
  document.getElementById('searchBtn').addEventListener('click', performSearch);
  document.getElementById('clearSearchBtn').addEventListener('click', clearSearch);
  document.getElementById('searchDateInput').addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); performSearch(); }
  });
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(file) importData(file);
    e.target.value = '';
  });

  renderAll(); // instant render from local cache while Firebase connects
  initCloudSync();