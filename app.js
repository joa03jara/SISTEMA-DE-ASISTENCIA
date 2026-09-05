const STORAGE_KEY = "registro_curso_v1"; // se usa solo para migrar datos viejos una vez
const LIMITE_FALTAS = 5;

const firebaseConfig = {
  apiKey: "AIzaSyD5epR2sf2Zw78330fCPOgDGTzeHi5KJVI",
  authDomain: "registro-de-curso.firebaseapp.com",
  projectId: "registro-de-curso",
  storageBucket: "registro-de-curso.firebasestorage.app",
  messagingSenderId: "539537852895",
  appId: "1:539537852895:web:b75bc84abf04ff7c719c6a",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Permite que seguir funcionando sin señal (guarda una copia local para consultar/editar offline)
db.enablePersistence({ synchronizeTabs: true }).catch(() => { /* ya estaba habilitado o el navegador no lo soporta */ });

function emptyCourseData() {
  return { students: [], groups: [], attendance: {}, tps: [], submissions: {}, maxGroupSize: 4 };
}

function defaultData() {
  const firstCourseId = 1;
  return {
    version: 2,
    nextId: 2,
    currentCourseId: firstCourseId,
    courses: [{ id: firstCourseId, name: "Mi curso" }],
    courseData: { [firstCourseId]: emptyCourseData() },
  };
}

// Migracion: si en este dispositivo habia datos guardados de la version vieja (antes de Firebase),
// los convertimos al formato con cursos para no perderlos.
function migrateLegacyLocalData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!parsed) return null;

  if (parsed.version === 2) return parsed;

  const firstCourseId = parsed.nextId ? parsed.nextId + 1 : 1;
  return {
    version: 2,
    nextId: firstCourseId + 1,
    currentCourseId: firstCourseId,
    courses: [{ id: firstCourseId, name: "Mi curso" }],
    courseData: {
      [firstCourseId]: {
        students: parsed.students || [],
        groups: parsed.groups || [],
        attendance: parsed.attendance || {},
        tps: parsed.tps || [],
        submissions: parsed.submissions || {},
        maxGroupSize: parsed.maxGroupSize || 4,
      },
    },
  };
}

let data = null;
let currentUser = null;
let view = "panel";
let selectedPick = [];
window.getSelectedPick = () => selectedPick; // util interno, no afecta la app

function currentCourse() {
  return data.courseData[data.currentCourseId];
}
window.currentCourse = currentCourse;

function newId() { return data.nextId++; }

function docRef(uid) {
  return db.collection("users").doc(uid).collection("appData").doc("main");
}

async function saveData() {
  window.data = data;
  if (!currentUser) return;
  try {
    await docRef(currentUser.uid).set(data);
  } catch (e) {
    showToast("No se pudo guardar (revisa la conexion). Se reintentara solo.", "error");
  }
}

async function loadDataForUser(user) {
  currentUser = user;
  const ref = docRef(user.uid);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      data = snap.data();
    } else {
      // Primera vez que este usuario entra: intenta traer datos viejos de este dispositivo, si habia
      data = migrateLegacyLocalData() || defaultData();
      await ref.set(data);
    }
  } catch (e) {
    // Sin conexion la primera vez que se abre en un dispositivo nuevo: no hay nada que mostrar todavia
    data = migrateLegacyLocalData() || defaultData();
  }
  window.data = data;
  document.getElementById("user-email-note").textContent = user.email;
  showApp();
}

function showApp() {
  document.getElementById("loading-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-root").classList.remove("hidden");
  renderCourseSelect();
  renderPanel();
}

function showLogin() {
  document.getElementById("loading-screen").classList.add("hidden");
  document.getElementById("app-root").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
}

document.getElementById("btn-login").addEventListener("click", debounceClick(async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  if (!email || !password) { errorEl.textContent = "Completa el email y la contrasena."; return; }
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (e) {
    errorEl.textContent = "Email o contrasena incorrectos.";
  }
}));

document.getElementById("login-password").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  const ok = await showConfirm("Cerrar sesion?");
  if (!ok) return;
  await auth.signOut();
});

auth.onAuthStateChanged(user => {
  if (user) {
    loadDataForUser(user);
  } else {
    currentUser = null;
    data = null;
    showLogin();
  }
});

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}

function statusLabel(status) {
  if (status === "al_dia") return "Al dia";
  if (status === "riesgo") return "En riesgo";
  return "Libre";
}

function faltasFor(studentId) {
  let count = 0;
  Object.values(currentCourse().attendance).forEach(day => {
    if (day[studentId] === false) count++;
  });
  return count;
}

function statusFor(faltas) {
  if (faltas >= LIMITE_FALTAS) return "libre";
  if (faltas >= LIMITE_FALTAS - 2) return "riesgo";
  return "al_dia";
}

function groupNameFor(student) {
  const g = currentCourse().groups.find(g => g.id === student.groupId);
  return g ? g.name : null;
}

function studentsWithInfo() {
  return currentCourse().students
    .map(s => {
      const faltas = faltasFor(s.id);
      const tps = currentCourse().tps.map(tp => ({
        tp_id: tp.id,
        tp_name: tp.name,
        submitted: !!(currentCourse().submissions[tp.id] && currentCourse().submissions[tp.id][s.id]),
      }));
      return {
        ...s,
        faltas,
        status: statusFor(faltas),
        group_name: groupNameFor(s),
        tps,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function emptyState(msg) { return `<div class="empty-state">${msg}</div>`; }

// Evita que un doble toque / doble clic dispare la accion dos veces
function debounceClick(fn, delay = 500) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last < delay) return;
    last = now;
    fn.apply(this, args);
  };
}

function nameTaken(list, name, excludeId = null) {
  const n = name.trim().toLowerCase();
  return list.some(item => item.id !== excludeId && item.name.trim().toLowerCase() === n);
}

// ---------- Iconos SVG (inline, sin depender de internet) ----------

const ICON_CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4.5 12.5 9.5 17.5 19.5 6.5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 20 7"/><path d="M6.5 7V5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 5v2"/><path d="M6.5 7l1 12.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5L17.5 7"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

// ---------- Notificaciones propias (reemplazan alert / confirm) ----------

function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  (window.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

function showConfirm(message, okLabel = "Eliminar") {
  return new Promise(resolve => {
    const overlay = document.getElementById("confirm-overlay");
    document.getElementById("confirm-message").textContent = message;
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    okBtn.textContent = okLabel;
    overlay.classList.remove("hidden");

    function cleanup(result) {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
  });
}



// ---------- Navigation ----------

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    switchView(btn.dataset.view);
    closeMobileMenu();
  });
});

function openMobileMenu() {
  document.getElementById("app-root").classList.add("menu-open");
}
function closeMobileMenu() {
  document.getElementById("app-root").classList.remove("menu-open");
}
document.getElementById("hamburger-btn").addEventListener("click", openMobileMenu);
document.getElementById("sidebar-backdrop").addEventListener("click", closeMobileMenu);

const titles = {
  panel: ["Panel del curso", "Vista general de asistencia y trabajos practicos"],
  alumnos: ["Alumnos", "Cargar y administrar el listado del curso"],
  asistencia: ["Tomar asistencia", "Se guarda por fecha, miercoles y viernes"],
  tps: ["Trabajos practicos", "Marca entregas por grupo o individuales"],
  grupos: ["Grupos", "Se arman una vez y quedan fijos"],
};

function switchView(v) {
  view = v;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  document.querySelectorAll(".view").forEach(el => el.classList.add("hidden"));
  document.getElementById(`view-${v}`).classList.remove("hidden");
  document.getElementById("view-title").textContent = titles[v][0];
  document.getElementById("view-sub").textContent = titles[v][1];

  if (v === "panel") renderPanel();
  if (v === "alumnos") renderStudentsTable();
  if (v === "asistencia") renderAttendance();
  if (v === "tps") renderTpList();
  if (v === "grupos") { selectedPick = []; syncGroupSizeUI(); renderGroupPicker(); renderGroupList(); }
}

function syncGroupSizeUI() {
  const select = document.getElementById("max-group-size");
  select.value = String(currentCourse().maxGroupSize);
  document.getElementById("group-size-hint").textContent = `Elegi hasta ${currentCourse().maxGroupSize} integrante${currentCourse().maxGroupSize === 1 ? "" : "s"} para el nuevo grupo.`;
}

document.getElementById("max-group-size").addEventListener("change", e => {
  currentCourse().maxGroupSize = Number(e.target.value);
  selectedPick = selectedPick.slice(0, currentCourse().maxGroupSize);
  saveData();
  document.getElementById("group-size-hint").textContent = `Elegi hasta ${currentCourse().maxGroupSize} integrante${currentCourse().maxGroupSize === 1 ? "" : "s"} para el nuevo grupo.`;
  renderGroupPicker();
});

// ---------- Panel ----------

function renderPanel() {
  const students = studentsWithInfo();
  const total = students.length;
  const al_dia = students.filter(s => s.status === "al_dia").length;
  const riesgo = students.filter(s => s.status === "riesgo").length;
  const libre = students.filter(s => s.status === "libre").length;

  const ICON_USERS = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.3"/><path d="M3.5 20c0-3.3 2.5-6 6-6s6 2.7 6 6"/><path d="M14.5 14.3c2.2.3 3.9 2.3 3.9 4.7"/></svg>';
  const ICON_CHECK_CIRCLE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.6 2.6L16.2 9"/></svg>';
  const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
  const ICON_X_CIRCLE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><line x1="9.2" y1="9.2" x2="14.8" y2="14.8"/><line x1="14.8" y1="9.2" x2="9.2" y2="14.8"/></svg>';

  document.getElementById("stat-grid").innerHTML = `
    <div class="stat-card" data-idx="01"><div class="stat-icon">${ICON_USERS}</div><div><p class="stat-label">Alumnos</p><p class="stat-value">${total}</p></div></div>
    <div class="stat-card success" data-idx="02"><div class="stat-icon">${ICON_CHECK_CIRCLE}</div><div><p class="stat-label">Al dia</p><p class="stat-value">${al_dia}</p></div></div>
    <div class="stat-card warn" data-idx="03"><div class="stat-icon">${ICON_CLOCK}</div><div><p class="stat-label">En riesgo</p><p class="stat-value">${riesgo}</p></div></div>
    <div class="stat-card danger" data-idx="04"><div class="stat-icon">${ICON_X_CIRCLE}</div><div><p class="stat-label">Libres</p><p class="stat-value">${libre}</p></div></div>
  `;
  renderPanelTable(students);
}

function renderPanelTable(students) {
  const tpNames = currentCourse().tps.map(t => t.name);
  let html = `<table><thead><tr>
    <th>Alumno</th><th>Grupo</th><th class="text-center">Faltas</th>
    ${tpNames.map(n => `<th class="text-center">${n}</th>`).join("")}
    <th class="text-center">Estado</th>
  </tr></thead><tbody>`;
  students.forEach(s => {
    html += `<tr>
      <td><div class="name-cell" onclick="openProfile(${s.id})"><div class="avatar ${s.status}">${initials(s.name)}</div>${s.name}</div></td>
      <td>${s.group_name || "Individual"}</td>
      <td class="text-center faltas-count">${s.faltas}</td>
      ${s.tps.map(t => `<td class="text-center">${t.submitted ? `<span class="check-yes">${ICON_CHECK}</span>` : `<span class="check-no">${ICON_X}</span>`}</td>`).join("")}
      <td class="text-center"><span class="status-pill ${s.status}">${statusLabel(s.status)}</span></td>
    </tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("table-panel").innerHTML = students.length ? html : emptyState("Todavia no cargaste alumnos. Anda a la seccion Alumnos para empezar.");
}

document.getElementById("search-panel").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  renderPanelTable(studentsWithInfo().filter(s => s.name.toLowerCase().includes(q)));
});

// ---------- Alumnos ----------

function renderStudentsTable() {
  const students = studentsWithInfo();
  let html = `<table><thead><tr>
    <th>Alumno</th><th>Grupo</th><th class="text-center">Faltas</th><th class="text-center">Estado</th><th></th>
  </tr></thead><tbody>`;
  students.forEach(s => {
    html += `<tr>
      <td><div class="name-cell" onclick="openProfile(${s.id})"><div class="avatar ${s.status}">${initials(s.name)}</div>${s.name}</div></td>
      <td>${s.group_name || "Individual"}</td>
      <td class="text-center faltas-count">${s.faltas}</td>
      <td class="text-center"><span class="status-pill ${s.status}">${statusLabel(s.status)}</span></td>
      <td class="text-center"><button class="link-btn" onclick="deleteStudent(${s.id})">${ICON_TRASH} Eliminar</button></td>
    </tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("table-alumnos").innerHTML = students.length ? html : emptyState("Agrega tu primer alumno con el boton de arriba.");
}

document.getElementById("btn-add-student").addEventListener("click", debounceClick(() => {
  const input = document.getElementById("new-student-name");
  const name = input.value.trim();
  if (!name) { showToast("Escribi el nombre del alumno", "error"); return; }
  if (nameTaken(currentCourse().students, name)) { showToast("Ya existe un alumno cargado con ese nombre.", "error"); return; }
  currentCourse().students.push({ id: newId(), name, groupId: null, notes: "" });
  saveData();
  input.value = "";
  renderStudentsTable();
}));

document.getElementById("new-student-name").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-add-student").click();
});

function cleanBulkLine(line) {
  // Quita numeracion tipo "1." "2-" "3_" "12)" al inicio de la linea
  return line.replace(/^\s*\d+\s*[\.\-_\):]\s*/, "").trim();
}

document.getElementById("btn-bulk-add").addEventListener("click", debounceClick(() => {
  const textarea = document.getElementById("bulk-students");
  const lines = textarea.value.split("\n").map(cleanBulkLine).filter(l => l.length > 0);
  if (!lines.length) { showToast("Pega al menos un nombre, uno por linea", "error"); return; }

  const existing = new Set(currentCourse().students.map(s => s.name.toLowerCase()));
  let added = 0;
  let skipped = 0;
  lines.forEach(name => {
    if (existing.has(name.toLowerCase())) { skipped++; return; }
    currentCourse().students.push({ id: newId(), name, groupId: null, notes: "" });
    existing.add(name.toLowerCase());
    added++;
  });
  saveData();
  textarea.value = "";
  renderStudentsTable();
  showToast(`Se agregaron ${added} alumnos.` + (skipped ? ` (${skipped} ya estaban cargados y se omitieron)` : ""), "success");
}));

async function deleteStudent(id) {
  const ok = await showConfirm("Eliminar este alumno y todo su historial?");
  if (!ok) return;
  currentCourse().students = currentCourse().students.filter(s => s.id !== id);
  Object.values(currentCourse().attendance).forEach(day => { delete day[id]; });
  Object.values(currentCourse().submissions).forEach(sub => { delete sub[id]; });
  saveData();
  renderStudentsTable();
}

// ---------- Asistencia ----------

function todayStr() { return new Date().toISOString().slice(0, 10); }

function renderAttendance() {
  const dateInput = document.getElementById("attendance-date");
  if (!dateInput.value) dateInput.value = todayStr();
  dateInput.onchange = renderAttendanceList;
  renderAttendanceList();
}

// ---------- Pestañas: Tomar asistencia / Historial ----------

document.getElementById("tab-tomar").addEventListener("click", () => switchAttendanceTab("tomar"));
document.getElementById("tab-historial").addEventListener("click", () => switchAttendanceTab("historial"));

function switchAttendanceTab(tab) {
  document.getElementById("tab-tomar").classList.toggle("active", tab === "tomar");
  document.getElementById("tab-historial").classList.toggle("active", tab === "historial");
  document.getElementById("asistencia-tomar-panel").classList.toggle("hidden", tab !== "tomar");
  document.getElementById("asistencia-historial-panel").classList.toggle("hidden", tab !== "historial");
  if (tab === "historial") renderAttendanceHistory();
}

function goToDate(date) {
  switchAttendanceTab("tomar");
  document.getElementById("attendance-date").value = date;
  renderAttendanceList();
}

function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}`;
}

function renderAttendanceHistory() {
  const query = (document.getElementById("search-historial").value || "").toLowerCase();
  const dates = Object.keys(currentCourse().attendance).sort();
  const container = document.getElementById("table-historial");

  if (!currentCourse().students.length) { container.innerHTML = emptyState("Todavia no hay alumnos cargados."); return; }
  if (!dates.length) { container.innerHTML = emptyState("Todavia no tomaste asistencia ningun dia."); return; }

  const students = currentCourse().students
    .filter(s => s.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  if (!students.length) { container.innerHTML = emptyState("No se encontraron alumnos con ese nombre."); return; }

  let html = '<div class="history-table-wrap"><table class="history-table"><thead><tr>';
  html += '<th class="sticky-col">Alumno</th>';
  dates.forEach(date => {
    html += `<th class="date-col text-center" title="Toca la fecha para editar ese dia">
      <span onclick="goToDate('${date}')">${formatDateShort(date)}</span>
      <button class="hist-date-del" title="Eliminar la asistencia de este dia" onclick="event.stopPropagation(); deleteAttendanceDate('${date}')">${ICON_TRASH}</button>
    </th>`;
  });
  html += '<th class="text-center">Faltas</th></tr></thead><tbody>';

  students.forEach(s => {
    html += `<tr><td class="sticky-col"><div class="name-cell" onclick="openProfile(${s.id})"><div class="avatar al_dia">${initials(s.name)}</div>${s.name}</div></td>`;
    let faltas = 0;
    dates.forEach(date => {
      const dayRecord = currentCourse().attendance[date];
      const hasRecord = Object.prototype.hasOwnProperty.call(dayRecord, s.id);
      let mark;
      if (!hasRecord) {
        mark = `<span class="hist-mark" style="background:var(--surface-2); color:var(--text-muted);">&mdash;</span>`;
      } else if (dayRecord[s.id] === false) {
        faltas++;
        mark = `<span class="hist-mark absent">${ICON_X}</span>`;
      } else {
        mark = `<span class="hist-mark present">${ICON_CHECK}</span>`;
      }
      html += `<td class="text-center">${mark}</td>`;
    });
    html += `<td class="text-center faltas-count">${faltas}</td></tr>`;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

document.getElementById("search-historial").addEventListener("input", renderAttendanceHistory);

async function deleteAttendanceDate(date) {
  const ok = await showConfirm(`Eliminar toda la asistencia del ${formatDateShort(date)}? Esto no se puede deshacer.`);
  if (!ok) return;
  delete currentCourse().attendance[date];
  saveData();
  renderAttendanceHistory();
  showToast("Se elimino la asistencia de ese dia", "success");
}

function renderAttendanceList() {
  const date = document.getElementById("attendance-date").value;
  const dayRecord = currentCourse().attendance[date] || {};
  const list = document.getElementById("attendance-list");
  if (!currentCourse().students.length) { list.innerHTML = emptyState("Todavia no hay alumnos cargados."); return; }

  list.innerHTML = currentCourse().students
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
    .map(s => {
      const present = dayRecord[s.id] !== undefined ? dayRecord[s.id] : true;
      return `
      <div class="attendance-row" data-id="${s.id}">
        <div class="attendance-name"><div class="avatar al_dia">${initials(s.name)}</div>${s.name}</div>
        <div class="toggle-group">
          <button class="toggle-btn present ${present ? "active" : ""}" onclick="setPresent(${s.id}, true)">${ICON_CHECK} Presente</button>
          <button class="toggle-btn absent ${!present ? "active" : ""}" onclick="setPresent(${s.id}, false)">${ICON_X} Ausente</button>
        </div>
      </div>`;
    }).join("");
}

const pendingAttendance = {};

function setPresent(id, present) {
  pendingAttendance[id] = present;
  const row = document.querySelector(`.attendance-row[data-id="${id}"]`);
  row.querySelector(".present").classList.toggle("active", present);
  row.querySelector(".absent").classList.toggle("active", !present);
}

document.getElementById("btn-save-attendance").addEventListener("click", debounceClick(() => {
  const date = document.getElementById("attendance-date").value;
  if (!date) { showToast("Elegi una fecha", "error"); return; }
  const rows = document.querySelectorAll(".attendance-row");
  if (!rows.length) { showToast("Todavia no hay alumnos cargados.", "error"); return; }
  if (!currentCourse().attendance[date]) currentCourse().attendance[date] = {};
  rows.forEach(row => {
    const id = Number(row.dataset.id);
    const present = row.querySelector(".present").classList.contains("active");
    currentCourse().attendance[date][id] = pendingAttendance[id] !== undefined ? pendingAttendance[id] : present;
  });
  saveData();
  showToast("Asistencia guardada", "success");
}));

// ---------- TPs ----------

function renderTpList() {
  const container = document.getElementById("tp-list");
  if (!currentCourse().tps.length) { container.innerHTML = emptyState("Todavia no cargaste ningun TP."); return; }

  const individuals = currentCourse().students.filter(s => !s.groupId).sort((a, b) => a.name.localeCompare(b.name, "es"));
  const groups = currentCourse().groups.slice().sort((a, b) => a.name.localeCompare(b.name, "es"));

  container.innerHTML = currentCourse().tps.map(tp => `
    <div class="tp-block">
      <div class="tp-block-head">
        <p class="tp-block-title">${tp.name}</p>
        <div style="display:flex; align-items:center; gap:14px;">
          <span class="tp-block-date">${tp.date || ""}</span>
          <button class="tp-del" onclick="deleteTp(${tp.id})">${ICON_TRASH} Eliminar</button>
        </div>
      </div>
      <div class="tp-members">
        ${groups.map(g => {
          const members = currentCourse().students.filter(s => s.groupId === g.id);
          if (!members.length) return "";
          const submitted = members.length && members.every(m => !!(currentCourse().submissions[tp.id] && currentCourse().submissions[tp.id][m.id]));
          const repId = members[0].id;
          return `<div class="tp-row group-row ${submitted ? "submitted" : ""}" onclick="toggleTpSubmission(${tp.id}, ${repId})">
            <div class="tp-row-info">
              <div class="avatar al_dia">${initials(g.name)}</div>
              <div class="tp-row-text">
                <p class="tp-row-name">${g.name}</p>
                <p class="tp-row-sub">${members.map(m => m.name).join(", ")}</p>
              </div>
            </div>
            <div class="tp-status"><span class="tp-status-dot"></span>${submitted ? "Entregado" : "Pendiente"}</div>
          </div>`;
        }).join("")}
        ${individuals.map(s => {
          const submitted = !!(currentCourse().submissions[tp.id] && currentCourse().submissions[tp.id][s.id]);
          return `<div class="tp-row ${submitted ? "submitted" : ""}" onclick="toggleTpSubmission(${tp.id}, ${s.id})">
            <div class="tp-row-info">
              <div class="avatar al_dia">${initials(s.name)}</div>
              <div class="tp-row-text"><p class="tp-row-name">${s.name}</p></div>
            </div>
            <div class="tp-status"><span class="tp-status-dot"></span>${submitted ? "Entregado" : "Pendiente"}</div>
          </div>`;
        }).join("")}
        ${(!groups.some(g => currentCourse().students.some(s => s.groupId === g.id)) && !individuals.length) ? emptyState("Todavia no hay alumnos cargados.") : ""}
      </div>
    </div>
  `).join("");
}

function toggleTpSubmission(tpId, studentId) {
  if (!currentCourse().submissions[tpId]) currentCourse().submissions[tpId] = {};
  const current = !!currentCourse().submissions[tpId][studentId];
  const newValue = !current;

  const student = currentCourse().students.find(s => s.id === studentId);
  let ids = [studentId];
  if (student.groupId) {
    ids = currentCourse().students.filter(s => s.groupId === student.groupId).map(s => s.id);
  }
  ids.forEach(id => { currentCourse().submissions[tpId][id] = newValue; });
  saveData();
  renderTpList();
}

async function deleteTp(id) {
  const ok = await showConfirm("Eliminar este TP?");
  if (!ok) return;
  currentCourse().tps = currentCourse().tps.filter(t => t.id !== id);
  delete currentCourse().submissions[id];
  saveData();
  renderTpList();
}

document.getElementById("btn-add-tp").addEventListener("click", debounceClick(() => {
  const input = document.getElementById("new-tp-name");
  const name = input.value.trim();
  if (!name) { showToast("Escribi el nombre del TP", "error"); return; }
  if (nameTaken(currentCourse().tps, name)) { showToast("Ya existe un TP cargado con ese nombre.", "error"); return; }
  currentCourse().tps.push({ id: newId(), name, date: todayStr() });
  saveData();
  input.value = "";
  renderTpList();
}));

document.getElementById("new-tp-name").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-add-tp").click();
});

// ---------- Grupos ----------

function renderGroupPicker() {
  const grouped = new Set(currentCourse().students.filter(s => s.groupId).map(s => s.id));
  const available = currentCourse().students.filter(s => !grouped.has(s.id));
  const picker = document.getElementById("group-picker");
  if (!available.length) { picker.innerHTML = emptyState("Todos los alumnos ya estan en un grupo, o todavia no cargaste alumnos."); return; }
  picker.innerHTML = available.map(s => `
    <div class="pick-chip ${selectedPick.includes(s.id) ? "selected" : ""}" onclick="togglePick(${s.id})">
      <span class="pick-chip-box">&#10003;</span>${s.name}
    </div>
  `).join("");
}

function togglePick(id) {
  if (selectedPick.includes(id)) {
    selectedPick = selectedPick.filter(x => x !== id);
  } else {
    if (selectedPick.length >= currentCourse().maxGroupSize) { showToast(`Un grupo puede tener hasta ${currentCourse().maxGroupSize} integrante${currentCourse().maxGroupSize === 1 ? "" : "s"}`, "error"); return; }
    selectedPick.push(id);
  }
  renderGroupPicker();
}

function renderGroupList() {
  const list = document.getElementById("group-list");
  if (!currentCourse().groups.length) { list.innerHTML = emptyState("Todavia no armaste grupos."); return; }
  list.innerHTML = currentCourse().groups.map(g => {
    const members = currentCourse().students.filter(s => s.groupId === g.id);
    return `
    <div class="group-card">
      <div class="group-card-head">
        <div class="group-card-icon">${initials(g.name)}</div>
        <div>
          <p class="group-card-name">${g.name}</p>
          <p class="group-card-members">${members.map(m => m.name).join(", ") || "Sin integrantes"}</p>
        </div>
      </div>
      <button class="link-btn" onclick="deleteGroup(${g.id})">${ICON_TRASH} Eliminar</button>
    </div>`;
  }).join("");
}

document.getElementById("btn-add-group").addEventListener("click", debounceClick(() => {
  const input = document.getElementById("new-group-name");
  const name = input.value.trim();
  if (!name) { showToast("Escribi el nombre del grupo", "error"); return; }
  if (nameTaken(currentCourse().groups, name)) { showToast("Ya existe un grupo con ese nombre.", "error"); return; }
  if (!selectedPick.length) { showToast("Elegi al menos un integrante", "error"); return; }
  const groupId = newId();
  currentCourse().groups.push({ id: groupId, name });
  selectedPick.forEach(sid => {
    const student = currentCourse().students.find(s => s.id === sid);
    if (student) student.groupId = groupId;
  });
  saveData();
  input.value = "";
  selectedPick = [];
  renderGroupPicker();
  renderGroupList();
}));

async function deleteGroup(id) {
  const ok = await showConfirm("Eliminar este grupo? Los alumnos quedan como individuales.");
  if (!ok) return;
  currentCourse().students.forEach(s => { if (s.groupId === id) s.groupId = null; });
  currentCourse().groups = currentCourse().groups.filter(g => g.id !== id);
  saveData();
  renderGroupPicker();
  renderGroupList();
}

// ---------- Student profile modal ----------

function openProfile(id) {
  const s = studentsWithInfo().find(x => x.id === id);
  if (!s) return;
  const overlay = document.getElementById("modal-overlay");
  document.getElementById("modal-content").innerHTML = `
    <button class="modal-close" onclick="closeModal()">Cerrar</button>
    <div style="display:flex; align-items:center; gap:13px; margin-bottom:18px;">
      <div class="avatar ${s.status}" style="width:46px;height:46px;font-size:15px;">${initials(s.name)}</div>
      <div>
        <p style="font-family: var(--font-display); font-weight:700; font-size:17px; margin:0;">${s.name}</p>
        <p class="muted" style="margin:2px 0 0;">${s.group_name || "Individual"}</p>
      </div>
    </div>
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:11px; margin-bottom:18px;">
      <div class="stat-card"><p class="stat-label">Faltas</p><p class="stat-value">${s.faltas} / ${LIMITE_FALTAS}</p></div>
      <div class="stat-card"><p class="stat-label">Estado</p><p class="stat-value" style="font-size:17px;">${statusLabel(s.status)}</p></div>
    </div>
    <p style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-secondary); margin: 0 0 9px;">Trabajos practicos</p>
    <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:20px;">
      ${s.tps.length ? s.tps.map(t => `
        <div style="display:flex; justify-content:space-between; font-size:13.5px; padding:7px 0; border-bottom:1px solid var(--line);">
          <span>${t.tp_name}</span>
          <span class="${t.submitted ? "check-yes" : "check-no"}">${t.submitted ? "Entregado" : "Pendiente"}</span>
        </div>`).join("") : '<p class="muted small">Todavia no hay TPs cargados.</p>'}
    </div>
    <p style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-secondary); margin: 0 0 9px;">Observaciones</p>
    <textarea id="notes-field" style="width:100%; min-height:76px; border:1px solid var(--line); border-radius:9px; padding:9px 11px; font-family: var(--font-body); font-size:13.5px; resize:vertical;">${s.notes || ""}</textarea>
    <div style="display:flex; justify-content:flex-end; margin-top:11px;">
      <button class="btn btn-accent" onclick="saveNotes(${s.id})">Guardar</button>
    </div>
  `;
  overlay.classList.remove("hidden");
}

function closeModal() { document.getElementById("modal-overlay").classList.add("hidden"); }

function saveNotes(id) {
  const notes = document.getElementById("notes-field").value;
  const student = currentCourse().students.find(s => s.id === id);
  if (student) student.notes = notes;
  saveData();
  closeModal();
  if (view === "panel") renderPanel();
  if (view === "alumnos") renderStudentsTable();
}

document.getElementById("modal-overlay").addEventListener("click", e => {
  if (e.target.id === "modal-overlay") closeModal();
});

// ---------- Cursos ----------

function renderCourseSelect() {
  const current = data.courses.find(c => c.id === data.currentCourseId);
  document.getElementById("course-current-name").textContent = current ? current.name : "Curso";
  renderCourseDropdownList();
}

function renderCourseDropdownList() {
  const dropdown = document.getElementById("course-dropdown");
  dropdown.innerHTML = data.courses.map(c => `
    <div class="course-dropdown-item ${c.id === data.currentCourseId ? "active" : ""}" onclick="selectCourseFromDropdown(${c.id})">
      ${c.name}
      ${c.id === data.currentCourseId ? ICON_CHECK : ""}
    </div>
  `).join("");
}

function selectCourseFromDropdown(id) {
  data.currentCourseId = id;
  saveData();
  selectedPick = [];
  renderCourseSelect();
  closeCourseDropdown();
  switchView(view);
}

function toggleCourseDropdown() {
  const dropdown = document.getElementById("course-dropdown");
  const willOpen = dropdown.classList.contains("hidden");
  if (willOpen) positionCourseDropdown();
  dropdown.classList.toggle("hidden");
}

function positionCourseDropdown() {
  const btn = document.getElementById("course-current-btn");
  const dropdown = document.getElementById("course-dropdown");
  const rect = btn.getBoundingClientRect();
  const dropdownWidth = 236;
  let left = rect.left;
  if (left + dropdownWidth > window.innerWidth - 8) {
    left = window.innerWidth - dropdownWidth - 8;
  }
  if (left < 8) left = 8;
  dropdown.style.top = `${rect.bottom + 6}px`;
  dropdown.style.left = `${left}px`;
}

function closeCourseDropdown() {
  document.getElementById("course-dropdown").classList.add("hidden");
}

document.getElementById("course-current-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleCourseDropdown();
});

document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("course-dropdown");
  if (!dropdown.classList.contains("hidden") && !dropdown.contains(e.target) && e.target.id !== "course-current-btn") {
    closeCourseDropdown();
  }
});

document.getElementById("btn-manage-courses").addEventListener("click", openCourseManager);

function openCourseManager() {
  renderCourseManagerContent();
  document.getElementById("modal-overlay").classList.remove("hidden");
}

function renderCourseManagerContent() {
  document.getElementById("modal-content").innerHTML = `
    <button class="modal-close" onclick="closeModal()">Cerrar</button>
    <p style="font-family: var(--font-display); font-weight:700; font-size:16px; margin:0 0 4px;">Mis cursos</p>
    <p class="muted small" style="margin:0 0 16px;">Cada curso tiene sus propios alumnos, grupos, asistencia y TPs.</p>

    <div id="course-manager-list" style="display:flex; flex-direction:column; gap:9px; margin-bottom:20px;"></div>

    <p style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-secondary); margin: 0 0 9px;">Agregar curso nuevo</p>
    <div style="display:flex; gap:8px;">
      <input type="text" id="new-course-name" placeholder="Ej: 4to año - Turno tarde" class="input-inline" style="flex:1;">
      <button class="btn btn-accent" id="btn-add-course">Crear</button>
    </div>
  `;
  renderCourseManagerList();
  document.getElementById("btn-add-course").addEventListener("click", debounceClick(addCourse));
  document.getElementById("new-course-name").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("btn-add-course").click();
  });
}

const ICON_PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

function renderCourseManagerList() {
  const list = document.getElementById("course-manager-list");
  list.innerHTML = data.courses.map(c => `
    <div class="course-card">
      <div class="course-card-name-wrap">
        <p class="course-card-name" id="course-name-display-${c.id}">${c.name}</p>
        <input type="text" class="input-inline course-rename-input hidden" id="course-name-input-${c.id}" value="${c.name}" data-course-id="${c.id}">
      </div>
      <div class="course-card-actions">
        <button class="icon-btn" title="Renombrar curso" onclick="startRenameCourse(${c.id})">${ICON_PENCIL}</button>
        ${c.id === data.currentCourseId ? '<span class="status-pill al_dia">Actual</span>' : `<button class="btn" onclick="switchToCourse(${c.id})">Usar</button>`}
        <button class="link-btn" onclick="deleteCourse(${c.id})">${ICON_TRASH}</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".course-rename-input").forEach(input => {
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("blur", () => renameCourse(Number(input.dataset.courseId), input.value));
  });
}

function startRenameCourse(id) {
  document.getElementById(`course-name-display-${id}`).classList.add("hidden");
  const input = document.getElementById(`course-name-input-${id}`);
  input.classList.remove("hidden");
  input.focus();
  input.select();
}

function switchToCourse(id) {
  data.currentCourseId = id;
  saveData();
  selectedPick = [];
  renderCourseSelect();
  renderCourseManagerList();
  switchView(view);
}

async function renameCourse(id, newName) {
  const name = newName.trim();
  if (!name) { showToast("El nombre del curso no puede quedar vacio", "error"); renderCourseManagerList(); return; }
  if (data.courses.some(c => c.id !== id && c.name.trim().toLowerCase() === name.toLowerCase())) {
    showToast("Ya existe un curso con ese nombre", "error");
    renderCourseManagerList();
    return;
  }
  const course = data.courses.find(c => c.id === id);
  course.name = name;
  saveData();
  renderCourseSelect();
  renderCourseManagerList();
}

const addCourse = () => {
  const input = document.getElementById("new-course-name");
  const name = input.value.trim();
  if (!name) { showToast("Escribi el nombre del curso", "error"); return; }
  if (nameTaken(data.courses, name)) { showToast("Ya existe un curso con ese nombre", "error"); return; }
  const id = newId();
  data.courses.push({ id, name });
  data.courseData[id] = emptyCourseData();
  saveData();
  input.value = "";
  renderCourseSelect();
  renderCourseManagerList();
  showToast(`Curso "${name}" creado`, "success");
};

async function deleteCourse(id) {
  if (data.courses.length <= 1) {
    showToast("Tiene que quedar al menos un curso.", "error");
    return;
  }
  const course = data.courses.find(c => c.id === id);
  const ok = await showConfirm(`Eliminar el curso "${course.name}"? Se borran todos sus alumnos, asistencias, grupos y TPs. Esto no se puede deshacer.`);
  if (!ok) return;

  data.courses = data.courses.filter(c => c.id !== id);
  delete data.courseData[id];
  if (data.currentCourseId === id) {
    data.currentCourseId = data.courses[0].id;
  }
  saveData();
  renderCourseSelect();
  renderCourseManagerList();
  switchView(view);
  showToast("Curso eliminado", "success");
}

// ---------- Init ----------
// El arranque real pasa por auth.onAuthStateChanged (ver arriba):
// muestra el login o carga los datos y recien ahi pinta el panel.