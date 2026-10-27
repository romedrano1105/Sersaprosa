// Datos exactos del Figma (App.tsx)
const employees = [
  {
    id: 1,
    name: "Carlos Mendoza",
    role: "Conductor Senior",
    license: "Pesada T",
    exp: "8 años",
    image: "https://images.unsplash.com/photo-1609436132311-e4b0c9370469?auto=format&fit=crop&w=240&q=80"
  },
  {
    id: 2,
    name: "María Hernández",
    role: "Agente de Seguridad",
    license: "Pesada T",
    exp: "6 años",
    image: "https://images.unsplash.com/photo-1609371497456-3a55a205d5eb?auto=format&fit=crop&w=240&q=80"
  },
  {
    id: 3,
    name: "José Ramírez",
    role: "Conductor Operativo",
    license: "Pesada T",
    exp: "5 años",
    image: "https://images.unsplash.com/photo-1523529831-3b6372bedacd?auto=format&fit=crop&w=240&q=80"
  }
];

const vehicles = [
  {
    id: 1,
    name: "Camión Blindado #08",
    model: "Mercedes-Benz Atego",
    plate: "N 14-820",
    fuel: 86,
    km: "48,210 km"
  },
  {
    id: 2,
    name: "Camión Blindado #12",
    model: "Ford F-550 Armored",
    plate: "N 09-415",
    fuel: 72,
    km: "31,892 km"
  },
  {
    id: 3,
    name: "Camión Blindado #05",
    model: "International MV",
    plate: "N 22-703",
    fuel: 94,
    km: "62,104 km"
  }
];

// Estado de la pantalla
let selectedEmployee = employees[0];
let selectedVehicle = vehicles[0];
let searchTerm = "";

// Elementos DOM
const employeeListContainer = document.getElementById("employeeListContainer");
const vehicleListContainer = document.getElementById("vehicleListContainer");
const searchInput = document.getElementById("searchInput");
const badgeEmployeesCount = document.getElementById("badgeEmployeesCount");
const badgeVehiclesCount = document.getElementById("badgeVehiclesCount");

// Modal DOM
const assignModal = document.getElementById("assignModal");
const modalCloseBtn = document.getElementById("modalCloseBtn");
const btnQuickAssignOpen = document.getElementById("btnQuickAssignOpen");
const modalEmpImage = document.getElementById("modalEmpImage");
const modalEmpName = document.getElementById("modalEmpName");
const modalVehName = document.getElementById("modalVehName");
const btnConfirmAssign = document.getElementById("btnConfirmAssign");
const modalSuccessNote = document.getElementById("modalSuccessNote");
const btnAssignText = document.getElementById("btnAssignText");

// Renderizar empleados
function renderEmployees() {
  const filtered = employees.filter(emp =>
    emp.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    emp.role.toLowerCase().includes(searchTerm.toLowerCase())
  );

  badgeEmployeesCount.textContent = String(filtered.length).padStart(2, "0");

  employeeListContainer.innerHTML = filtered.map(emp => `
    <button class="employee-card ${selectedEmployee.name === emp.name ? 'selected' : ''}" onclick="selectEmployee('${emp.name}')">
      <img src="${emp.image}" alt="Retrato de ${emp.name}">
      <div class="employee-main">
        <div class="available-tag"><i></i> Disponible</div>
        <strong>${emp.name}</strong>
        <span>${emp.role}</span>
        <div class="employee-meta">
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M13 9h5M13 13h5M6 16h12"/></svg>
            Lic. ${emp.license}
          </span>
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            ${emp.exp}
          </span>
        </div>
      </div>
      <span class="card-arrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 18 6-6-6-6"/></svg>
      </span>
    </button>
  `).join("");
}

// Renderizar vehículos
function renderVehicles() {
  const filtered = vehicles.filter(veh =>
    veh.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    veh.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
    veh.plate.toLowerCase().includes(searchTerm.toLowerCase())
  );

  badgeVehiclesCount.textContent = String(filtered.length).padStart(2, "0");

  vehicleListContainer.innerHTML = filtered.map((veh, index) => `
    <button class="vehicle-card ${selectedVehicle.name === veh.name ? 'selected' : ''}" onclick="selectVehicle('${veh.name}')">
      <div class="truck-visual">
        <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>
        </svg>
        <span>0${index + 1}</span>
      </div>
      <div class="vehicle-details">
        <div class="available-tag"><i></i> Disponible</div>
        <strong>${veh.name}</strong>
        <span>${veh.model}</span>
        <div class="vehicle-stats">
          <div><small>PLACA</small><b>${veh.plate}</b></div>
          <div><small>ODÓMETRO</small><b>${veh.km}</b></div>
        </div>
        <div class="fuel">
          <span>Combustible</span>
          <span>${veh.fuel}%</span>
          <div><i style="width: ${veh.fuel}%"></i></div>
        </div>
      </div>
      <span class="card-arrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 18 6-6-6-6"/></svg>
      </span>
    </button>
  `).join("");
}

// Acciones de selección
window.selectEmployee = function(name) {
  selectedEmployee = employees.find(e => e.name === name) || selectedEmployee;
  renderEmployees();
  openModal();
};

window.selectVehicle = function(name) {
  selectedVehicle = vehicles.find(v => v.name === name) || selectedVehicle;
  renderVehicles();
  openModal();
};

// Modal handlers
function openModal() {
  modalEmpImage.src = selectedEmployee.image;
  modalEmpName.textContent = selectedEmployee.name;
  modalVehName.textContent = selectedVehicle.name;
  modalSuccessNote.style.display = "none";
  btnAssignText.textContent = "Vincular y Asignar";
  assignModal.style.display = "flex";
}

function closeModal() {
  assignModal.style.display = "none";
}

// Event Listeners
searchInput.addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderEmployees();
  renderVehicles();
});

btnQuickAssignOpen.addEventListener("click", openModal);
modalCloseBtn.addEventListener("click", closeModal);

assignModal.addEventListener("click", (e) => {
  if (e.target === assignModal) closeModal();
});

btnConfirmAssign.addEventListener("click", () => {
  btnAssignText.textContent = "Asignación completada";
  modalSuccessNote.style.display = "block";
  setTimeout(() => {
    closeModal();
  }, 950);
});

// Inicialización
renderEmployees();
renderVehicles();