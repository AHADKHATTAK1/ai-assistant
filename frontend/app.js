// BiteAI Dashboard Client App
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const defaultHost = 'localhost:5006';
const serverHost = window.location.host && window.location.protocol !== 'file:' ? window.location.host : defaultHost;
const wsUrl = (window.location.protocol === 'file:' ? 'ws:' : wsProtocol) + '//' + serverHost + '/ws';
const httpProtocol = window.location.protocol === 'file:' ? 'http:' : window.location.protocol;
const apiUrl = httpProtocol + '//' + serverHost + '/api';


// State variables
let menu = [];
let orders = [];
let activeCall = null;
let callTimerInterval = null;
let callDurationSeconds = 0;
let ws = null;
let currentTab = 'dashboard';
let charts = {};

// Default configurations
let systemConfig = {
  business_name: "Umair's Takeaway",
  business_phone: "01274502030",
  business_address: "Bradford, West Yorkshire",
  auto_print: true
};

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  try { setupTabs(); } catch(e) { console.error("Error setting up tabs:", e); }
  try { loadConfig(); } catch(e) { console.error("Error loading config:", e); }
  try { loadMenu(); } catch(e) { console.error("Error loading menu:", e); }
  try { loadOrders(); } catch(e) { console.error("Error loading orders:", e); }
  try { connectWebSocket(); } catch(e) { console.error("Error connecting websocket:", e); }
  try { setupEventListeners(); } catch(e) { console.error("Error setting up event listeners:", e); }
  try { initCharts(); } catch(e) { console.error("Error initializing charts:", e); }
});

// Setup sidebar tabs routing
function setupTabs() {
  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const tabId = item.getAttribute("data-tab");
      
      // Update sidebar state
      navItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      
      // Update tab content visibility
      document.querySelectorAll(".tab-content").forEach(content => {
        content.classList.add("hidden-element");
      });
      document.getElementById(`tab-${tabId}`).classList.remove("hidden-element");
      
      // Update header titles
      currentTab = tabId;
      const title = document.getElementById("tab-title");
      const subtitle = document.getElementById("tab-subtitle");
      
      if (tabId === 'dashboard') {
        title.innerText = "Live Monitor";
        subtitle.innerText = "Real-time phone calls and agent activity";
      } else if (tabId === 'orders') {
        title.innerText = "Orders Queue";
        subtitle.innerText = "Kitchen receipts and fulfillment tracker";
        renderOrders();
      } else if (tabId === 'menu') {
        title.innerText = "Menu Manager";
        subtitle.innerText = "Edit takeaway items, prices, and availability";
        renderMenuTable();
      } else if (tabId === 'settings') {
        title.innerText = "Connection & AI Settings";
        subtitle.innerText = "Configure Twilio webhooks, printers, and Gemini prompts";
        populateSettingsForm();
      }
    });
  });
}

// Fetch Business configuration
async function loadConfig() {
  try {
    const response = await fetch(`${apiUrl}/config`);
    if (response.ok) {
      systemConfig = await response.json();
      document.getElementById("orders-auto-print-toggle").checked = systemConfig.auto_print;
      
      // Update static branding
      document.getElementById("print-biz-name").innerText = systemConfig.business_name || "Umair's Takeaway";
      document.getElementById("print-biz-address").innerText = systemConfig.business_address || "Bradford";
      document.getElementById("print-biz-phone").innerText = "Phone: " + (systemConfig.business_phone || "01274502030");
    }
  } catch (e) {
    console.error("Error loading config:", e);
  }
}

// Fetch Menu Items
async function loadMenu() {
  try {
    const response = await fetch(`${apiUrl}/menu`);
    if (response.ok) {
      menu = await response.json();
      renderMenuTable();
    }
  } catch (e) {
    console.error("Error loading menu:", e);
  }
}

// Fetch Previous Orders
async function loadOrders() {
  try {
    const response = await fetch(`${apiUrl}/orders`);
    if (response.ok) {
      orders = await response.json();
      renderOrders();
      updateOrderCountBadge();
      updateQuickStats();
      updateChartsData();
    }
  } catch (e) {
    console.error("Error loading orders:", e);
  }
}

// Setup WebSocket Listener for Real-Time Call Events
function connectWebSocket() {
  const statusIndicator = document.getElementById("server-status");
  try {
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      statusIndicator.className = "status-indicator connected";
      statusIndicator.querySelector(".text").innerText = "Server Connected";
      console.log("WS connection established");
    };
    
    ws.onclose = () => {
      statusIndicator.className = "status-indicator disconnected";
      statusIndicator.querySelector(".text").innerText = "Server Disconnected";
      console.log("WS connection closed. Reconnecting in 5s...");
      setTimeout(connectWebSocket, 5000);
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWebSocketMessage(msg);
      } catch (e) {
        console.error("Failed to parse WS message:", e);
      }
    };
  } catch (err) {
    console.warn("WebSocket connection failed. Falling back to HTTP polling:", err);
    if (statusIndicator) {
      statusIndicator.className = "status-indicator disconnected";
      statusIndicator.querySelector(".text").innerText = "Server Disconnected (Polling)";
    }
  }
}

// Route incoming websocket events
function handleWebSocketMessage(msg) {
  switch (msg.type) {
    case "call_started":
      startActiveCall(msg.call_sid, msg.phone);
      break;
    case "call_updated":
      updateActiveCall(msg);
      break;
    case "call_completed":
      completeActiveCall(msg.order);
      break;
    case "order_status_updated":
      // Sync local status
      const order = orders.find(o => o.id === msg.id);
      if (order) order.status = msg.status;
      renderOrders();
      break;
  }
}

// Handle real-time Call start
function startActiveCall(sid, phone) {
  activeCall = {
    sid: sid,
    phone: phone,
    chat_history: [],
    cart: [],
    customer_info: { name: "", address: "", type: "" },
    sentiment: "neutral",
    language: "en-GB"
  };
  
  // Update Call Banner UI
  document.getElementById("no-call-container").classList.add("hidden-element");
  document.getElementById("active-call-container").classList.remove("hidden-element");
  document.getElementById("call-phone-number").innerHTML = `<i class="fa-solid fa-phone"></i> ${phone}`;
  document.getElementById("call-detected-lang").innerText = "Detecting...";
  document.getElementById("call-sentiment-badge").className = "badge-sentiment neutral";
  document.getElementById("call-sentiment-badge").innerHTML = `<i class="fa-solid fa-face-meh"></i> Neutral`;
  
  // Clear dialogue & cart
  document.getElementById("call-chat-history").innerHTML = `
    <div class="bubble bubble-ai">
      <span class="speaker-tag">AI Agent</span>
      Welcome to Umair's Takeaway. How can I help you today?
    </div>
  `;
  document.getElementById("call-cart-items").innerHTML = `
    <div class="empty-cart-message">
      <i class="fa-solid fa-shopping-basket"></i>
      <p>Cart is currently empty. List items as the customer orders them.</p>
    </div>
  `;
  
  resetCallTimer();
  startCallTimer();
  
  // Play ring/beep audio
  const beep = document.getElementById("sim-beep-audio");
  if (beep) beep.play().catch(e => console.log("Audio block: " + e));
  
  // Speak initial greeting
  speakTextInBrowser("Welcome to Umair's Takeaway. How can I help you today?", "en-GB", () => {
    if (activeCall && activeCall.sid.startsWith("mic_")) {
      runMicLoop(activeCall.sid);
    }
  });
}

// Handle real-time call updates (speech speech, AI answers, cart, sentiment)
function updateActiveCall(msg) {
  if (!activeCall || activeCall.sid !== msg.call_sid) return;
  
  // Append new user dialogue bubble
  const chatHistory = document.getElementById("call-chat-history");
  
  // Remove initial wait message if exists
  const waitMsg = chatHistory.querySelector(".system-message");
  if (waitMsg) waitMsg.remove();
  
  // Add User Speech Bubble
  const userBubble = document.createElement("div");
  userBubble.className = "bubble bubble-user";
  userBubble.innerHTML = `<span class="speaker-tag">Customer</span> ${msg.transcript.user}`;
  chatHistory.appendChild(userBubble);
  
  // Add AI Response Bubble
  setTimeout(() => {
    const aiBubble = document.createElement("div");
    aiBubble.className = "bubble bubble-ai";
    aiBubble.innerHTML = `<span class="speaker-tag">AI Agent</span> ${msg.transcript.ai}`;
    chatHistory.appendChild(aiBubble);
    
    // Auto-scroll chat panel to bottom
    chatHistory.scrollTop = chatHistory.scrollHeight;
    
    // Speak AI response aloud in browser
    speakTextInBrowser(msg.transcript.ai, msg.language, () => {
      if (activeCall && activeCall.sid.startsWith("mic_")) {
        runMicLoop(activeCall.sid);
      }
    });
  }, 500);
  
  // Update Cart details
  activeCall.cart = msg.cart;
  activeCall.customer_info = msg.customer_info;
  activeCall.sentiment = msg.sentiment;
  activeCall.language = msg.language;
  
  renderActiveCart();
  
  // Update Sentiment details
  const sentimentBadge = document.getElementById("call-sentiment-badge");
  sentimentBadge.className = `badge-sentiment ${msg.sentiment}`;
  
  let emoji = "meh";
  if (msg.sentiment === "happy") emoji = "smile";
  else if (msg.sentiment === "impatient") emoji = "hourglass-half";
  else if (msg.sentiment === "frustrated") emoji = "angry";
  
  sentimentBadge.innerHTML = `<i class="fa-solid fa-${emoji}"></i> ${capitalizeFirstLetter(msg.sentiment)}`;
  document.getElementById("call-detected-lang").innerText = msg.language;
}

// Call completed - save order and trigger thermal printer
function completeActiveCall(order) {
  activeCall = null;
  stopCallTimer();
  
  // Add order to local list
  orders.unshift(order);
  renderOrders();
  updateOrderCountBadge();
  updateQuickStats();
  updateChartsData();
  
  // Reset Live Monitor Tab
  document.getElementById("active-call-container").classList.add("hidden-element");
  document.getElementById("no-call-container").classList.remove("hidden-element");
  
  // Handle Auto-Printing!
  const autoPrintEnabled = document.getElementById("orders-auto-print-toggle").checked;
  if (autoPrintEnabled) {
    triggerReceiptPrint(order);
  }
}

// Print Receipt formatting and window print trigger
function triggerReceiptPrint(order) {
  console.log("Preparing receipt for print:", order.id);
  
  // Set meta values
  document.getElementById("print-order-id").innerText = "#" + order.id.substring(0, 8).toUpperCase();
  document.getElementById("print-order-time").innerText = order.time;
  document.getElementById("print-cust-name-receipt").innerText = order.customer_name;
  document.getElementById("print-cust-phone").innerText = order.phone;
  document.getElementById("print-order-type").innerText = order.delivery_type.toUpperCase();
  
  // Address section toggle
  const addressSec = document.getElementById("print-address-section");
  if (order.delivery_type === "delivery" && order.address) {
    addressSec.classList.remove("hidden-element");
    document.getElementById("print-cust-address-receipt").innerText = order.address;
  } else {
    addressSec.classList.add("hidden-element");
  }
  
  // Set items rows
  const tbody = document.getElementById("print-items-body");
  tbody.innerHTML = "";
  order.items.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.qty}x</td>
      <td>${item.name}</td>
      <td style="text-align: right;">£${(item.price * item.qty).toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
  
  // Set totals
  document.getElementById("print-subtotal").innerText = `£${order.subtotal.toFixed(2)}`;
  document.getElementById("print-delivery-fee").innerText = `£${order.delivery_fee.toFixed(2)}`;
  document.getElementById("print-total").innerText = `£${order.total.toFixed(2)}`;
  
  // Call window print (CSS handles standard thermal receipt styling and hides dashboard)
  setTimeout(() => {
    window.print();
  }, 200);
}

// Render active cart items
function renderActiveCart() {
  const container = document.getElementById("call-cart-items");
  if (!activeCall || activeCall.cart.length === 0) {
    container.innerHTML = `
      <div class="empty-cart-message">
        <i class="fa-solid fa-shopping-basket"></i>
        <p>Cart is currently empty. List items as the customer orders them.</p>
      </div>
    `;
    document.getElementById("cart-item-count").innerText = "0 items";
    document.getElementById("cart-subtotal").innerText = "£0.00";
    document.getElementById("cart-delivery-fee").innerText = "£0.00";
    document.getElementById("cart-total").innerText = "£0.00";
    return;
  }
  
  container.innerHTML = "";
  let subtotal = 0;
  let count = 0;
  
  activeCall.cart.forEach(item => {
    subtotal += item.price * item.qty;
    count += item.qty;
    
    const div = document.createElement("div");
    div.className = "cart-item";
    div.innerHTML = `
      <div class="cart-item-info">
        <h4>${item.name}</h4>
        <span>£${item.price.toFixed(2)} each</span>
      </div>
      <div class="cart-item-qty-price">
        <span class="qty">${item.qty}x</span>
        <span class="price">£${(item.price * item.qty).toFixed(2)}</span>
      </div>
    `;
    container.appendChild(div);
  });
  
  const deliveryType = activeCall.customer_info.type || "collection";
  const deliveryFee = deliveryType === "delivery" ? 2.50 : 0.00;
  const total = subtotal + deliveryFee;
  
  document.getElementById("cart-item-count").innerText = `${count} items`;
  document.getElementById("cart-subtotal").innerText = `£${subtotal.toFixed(2)}`;
  document.getElementById("cart-delivery-fee").innerText = `£${deliveryFee.toFixed(2)}`;
  document.getElementById("cart-total").innerText = `£${total.toFixed(2)}`;
  
  // Set customer details
  document.getElementById("cart-cust-type").innerText = capitalizeFirstLetter(deliveryType);
  document.getElementById("cart-cust-name").innerText = activeCall.customer_info.name || "Pending...";
  document.getElementById("cart-cust-address").innerText = activeCall.customer_info.address || "Pending...";
}

// Call duration counter
function startCallTimer() {
  callTimerInterval = setInterval(() => {
    callDurationSeconds++;
    const mins = String(Math.floor(callDurationSeconds / 60)).padStart(2, '0');
    const secs = String(callDurationSeconds % 60).padStart(2, '0');
    document.getElementById("call-duration-timer").innerText = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
}

function resetCallTimer() {
  stopCallTimer();
  callDurationSeconds = 0;
  document.getElementById("call-duration-timer").innerText = "00:00";
}

// Render Orders Tab List
function renderOrders() {
  const container = document.getElementById("orders-list-container");
  if (!container) return;
  
  // Get active filter status
  const filterBtn = document.querySelector(".btn-filter.active");
  const filter = filterBtn ? filterBtn.getAttribute("data-filter") : "all";
  
  const filteredOrders = orders.filter(o => filter === "all" || o.status === filter);
  
  if (filteredOrders.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
        <i class="fa-solid fa-receipt" style="font-size: 2.5rem; margin-bottom: 12px; opacity: 0.3;"></i>
        <p>No orders match this status filter.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = "";
  filteredOrders.forEach(o => {
    const card = document.createElement("div");
    card.className = "order-card";
    
    // Build items rows
    let itemsHtml = "";
    o.items.forEach(item => {
      itemsHtml += `
        <div class="order-item-row">
          <div class="qty-name">
            <span class="qty">${item.qty}x</span>
            <span class="name">${item.name}</span>
          </div>
          <span class="price">£${(item.price * item.qty).toFixed(2)}</span>
        </div>
      `;
    });
    
    // Status styles
    const statusOptions = ["Received", "Preparing", "Ready", "Completed"];
    let selectHtml = `<select class="order-status-select" onchange="changeOrderStatus('${o.id}', this.value)">`;
    statusOptions.forEach(opt => {
      selectHtml += `<option value="${opt}" ${o.status === opt ? 'selected' : ''}>${opt}</option>`;
    });
    selectHtml += `</select>`;
    
    // Details
    const addressHtml = o.delivery_type === "delivery" 
      ? `<p><i class="fa-solid fa-location-dot"></i> ${o.address}</p>` 
      : "";
      
    card.innerHTML = `
      <div class="order-card-header">
        <div class="order-meta-info">
          <h4>#${o.id.substring(0, 6).toUpperCase()}</h4>
          <span>${o.time}</span>
        </div>
        ${selectHtml}
      </div>
      <div class="order-customer-info">
        <p><i class="fa-solid fa-user"></i> ${o.customer_name}</p>
        <p><i class="fa-solid fa-phone"></i> ${o.phone}</p>
        <p><i class="fa-solid fa-bicycle"></i> ${capitalizeFirstLetter(o.delivery_type)}</p>
        ${addressHtml}
      </div>
      <div class="order-items-list">
        ${itemsHtml}
      </div>
      <div class="order-card-footer">
        <button class="btn btn-primary btn-sm" onclick="printOrderReceiptDirectly('${o.id}')">
          <i class="fa-solid fa-print"></i> Print
        </button>
        <div class="order-total-price">£${o.total.toFixed(2)}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

// Callback for status change from dashboard select
async function changeOrderStatus(id, newStatus) {
  try {
    const response = await fetch(`${apiUrl}/orders/update_status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: newStatus })
    });
    if (response.ok) {
      const order = orders.find(o => o.id === id);
      if (order) order.status = newStatus;
      renderOrders();
      updateChartsData();
    }
  } catch (e) {
    console.error("Error updating order status:", e);
  }
}

// Manual printing helper button
function printOrderReceiptDirectly(id) {
  const order = orders.find(o => o.id === id);
  if (order) {
    triggerReceiptPrint(order);
  }
}

// Render Menu Catalog Table
function renderMenuTable() {
  const tbody = document.getElementById("menu-items-table-body");
  if (!tbody) return;
  
  if (menu.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">
          Menu is empty. Click "Add Menu Item" to get started.
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = "";
  menu.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${item.name}</strong></td>
      <td><span class="badge badge-accent">${item.category}</span></td>
      <td><span class="menu-item-price">£${item.price.toFixed(2)}</span></td>
      <td style="color: var(--text-muted); font-size: 0.8rem; max-width: 250px;">${item.description || '-'}</td>
      <td>
        <span class="status-badge ${item.available ? 'active' : 'inactive'}">
          ${item.available ? 'Available' : 'Inactive'}
        </span>
      </td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="openEditMenuModal(${item.id})">
          <i class="fa-solid fa-pencil"></i> Edit
        </button>
        <button class="btn btn-secondary btn-sm" onclick="deleteMenuItem(${item.id})">
          <i class="fa-solid fa-trash-can"></i> Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Menu Items CRUD helpers
function openEditMenuModal(id) {
  const item = menu.find(i => i.id === id);
  if (!item) return;
  
  document.getElementById("menu-modal-title").innerText = "Edit Menu Item";
  document.getElementById("menu-item-id").value = item.id;
  document.getElementById("menu-item-name").value = item.name;
  document.getElementById("menu-item-price").value = item.price;
  document.getElementById("menu-item-category").value = item.category;
  document.getElementById("menu-item-description").value = item.description || "";
  document.getElementById("menu-item-available").checked = item.available;
  
  document.getElementById("menu-modal").classList.remove("hidden-element");
}

function openAddMenuModal() {
  document.getElementById("menu-modal-title").innerText = "Add Menu Item";
  document.getElementById("menu-item-id").value = "";
  document.getElementById("menu-item-name").value = "";
  document.getElementById("menu-item-price").value = "";
  document.getElementById("menu-item-category").value = "Pizzas";
  document.getElementById("menu-item-description").value = "";
  document.getElementById("menu-item-available").checked = true;
  
  document.getElementById("menu-modal").classList.remove("hidden-element");
}

async function saveMenuItem(e) {
  e.preventDefault();
  const idVal = document.getElementById("menu-item-id").value;
  const name = document.getElementById("menu-item-name").value;
  const price = parseFloat(document.getElementById("menu-item-price").value);
  const category = document.getElementById("menu-item-category").value;
  const description = document.getElementById("menu-item-description").value;
  const available = document.getElementById("menu-item-available").checked;
  
  let updatedMenu = [...menu];
  
  if (idVal) {
    // Edit existing
    const id = parseInt(idVal);
    updatedMenu = updatedMenu.map(item => {
      if (item.id === id) {
        return { id, name, price, category, description, available };
      }
      return item;
    });
  } else {
    // Create new
    const nextId = menu.length > 0 ? Math.max(...menu.map(i => i.id)) + 1 : 1;
    updatedMenu.push({ id: nextId, name, price, category, description, available });
  }
  
  // Save to backend
  try {
    const response = await fetch(`${apiUrl}/menu`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedMenu)
    });
    if (response.ok) {
      menu = updatedMenu;
      renderMenuTable();
      document.getElementById("menu-modal").classList.add("hidden-element");
    }
  } catch (e) {
    console.error("Error saving menu item:", e);
  }
}

async function deleteMenuItem(id) {
  if (!confirm("Are you sure you want to delete this menu item?")) return;
  
  const updatedMenu = menu.filter(item => item.id !== id);
  try {
    const response = await fetch(`${apiUrl}/menu`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedMenu)
    });
    if (response.ok) {
      menu = updatedMenu;
      renderMenuTable();
    }
  } catch (e) {
    console.error("Error deleting menu item:", e);
  }
}

// Populate settings page form
function populateSettingsForm() {
  document.getElementById("settings-gemini-key").value = systemConfig.gemini_api_key || "";
  document.getElementById("settings-prompt").value = systemConfig.system_prompt || "";
  document.getElementById("settings-biz-name").value = systemConfig.business_name || "";
  document.getElementById("settings-biz-phone").value = systemConfig.business_phone || "";
  document.getElementById("settings-biz-address").value = systemConfig.business_address || "";
  document.getElementById("settings-twilio-sid").value = systemConfig.twilio_account_sid || "";
  document.getElementById("settings-twilio-token").value = systemConfig.twilio_auth_token || "";
}

// Event handlers for Settings Forms
async function saveAISettings(e) {
  e.preventDefault();
  const config = {
    gemini_api_key: document.getElementById("settings-gemini-key").value,
    system_prompt: document.getElementById("settings-prompt").value
  };
  await sendConfigUpdate(config);
}

async function saveBusinessSettings(e) {
  e.preventDefault();
  const config = {
    business_name: document.getElementById("settings-biz-name").value,
    business_phone: document.getElementById("settings-biz-phone").value,
    business_address: document.getElementById("settings-biz-address").value,
    twilio_account_sid: document.getElementById("settings-twilio-sid").value,
    twilio_auth_token: document.getElementById("settings-twilio-token").value
  };
  await sendConfigUpdate(config);
}

async function sendConfigUpdate(config) {
  try {
    const response = await fetch(`${apiUrl}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    if (response.ok) {
      alert("Settings saved successfully!");
      loadConfig();
    }
  } catch (e) {
    console.error("Error saving config settings:", e);
  }
}

// Setup general Event Listeners
function setupEventListeners() {
  // Add menu modals
  document.getElementById("menu-add-item-btn").addEventListener("click", openAddMenuModal);
  document.getElementById("menu-modal-close").addEventListener("click", () => {
    document.getElementById("menu-modal").classList.add("hidden-element");
  });
  document.getElementById("menu-modal-cancel").addEventListener("click", () => {
    document.getElementById("menu-modal").classList.add("hidden-element");
  });
  document.getElementById("menu-item-form").addEventListener("submit", saveMenuItem);
  
  // Settings forms
  document.getElementById("settings-ai-form").addEventListener("submit", saveAISettings);
  document.getElementById("settings-business-form").addEventListener("submit", saveBusinessSettings);
  
  // Auto print toggle in settings
  document.getElementById("orders-auto-print-toggle").addEventListener("change", async (e) => {
    await sendConfigUpdate({ auto_print: e.target.checked });
  });
  
  // Orders status filters
  const filterBtns = document.querySelectorAll(".btn-filter");
  filterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderOrders();
    });
  });
  
  // Test Call Simulator Button
  document.getElementById("test-call-simulator-btn").addEventListener("click", () => {
    if (activeCall) {
      alert("An active call is already running!");
      return;
    }
    // Simulate incoming webhook trigger
    const mockSid = "sim_" + Math.random().toString(36).substring(2, 10);
    const mockFrom = "+44 " + Math.floor(1000000000 + Math.random() * 9000000000);
    
    // Send mock event to backend via fetch to simulate an incoming call
    fetch(`${httpProtocol}//${serverHost}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${mockSid}&From=${encodeURIComponent(mockFrom)}`
    }).then(() => {
      // Immediately set activeCall state so simulation doesn't bail out
      startActiveCall(mockSid, mockFrom);
      // Prompt user to type dialogue turns in simulation modal
      simulateSpeechPrompt(mockSid);
    });
  });

  // Talk with Mic (No Twilio) Button
  document.getElementById("start-mic-agent-btn").addEventListener("click", () => {
    startBrowserMicAgent();
  });
}

// Simulation Dialogue loop
function simulateSpeechPrompt(sid) {
  setTimeout(() => {
    if (!activeCall) return;
    const speech = prompt("Customer speech (type what the customer says to BiteAI):\ne.g. 'I want a Margherita Pizza and a Cheeseburger, for collection please. My name is John.'");
    if (speech) {
      fetch(`${httpProtocol}//${serverHost}/voice/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `CallSid=${sid}&SpeechResult=${encodeURIComponent(speech)}`
      }).then(async () => {
        // Sync state immediately in polling mode
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          await syncActiveCallStatus(sid);
        }
        
        // Recurse unless order completed
        setTimeout(() => {
          if (activeCall) {
            simulateSpeechPrompt(sid);
          }
        }, 1500);
      });
    } else {
      // Hang up
      console.log("Simulation cancelled by user");
    }
  }, 1000);
}

// Chart.js Configuration
function initCharts() {
  // Traffic chart (Hourly orders)
  const trafficCtx = document.getElementById("traffic-chart").getContext("2d");
  charts.traffic = new Chart(trafficCtx, {
    type: 'line',
    data: {
      labels: ['12 PM', '2 PM', '4 PM', '6 PM', '8 PM', '10 PM'],
      datasets: [{
        label: 'Orders',
        data: [2, 1, 5, 12, 18, 6],
        borderColor: '#818cf8',
        backgroundColor: 'rgba(129, 140, 248, 0.1)',
        tension: 0.4,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: '#243054' }, ticks: { color: '#9ca3af' } },
        x: { grid: { color: '#243054' }, ticks: { color: '#9ca3af' } }
      }
    }
  });
  
  // Sentiment Chart (Pie)
  const sentimentCtx = document.getElementById("sentiment-chart").getContext("2d");
  charts.sentiment = new Chart(sentimentCtx, {
    type: 'doughnut',
    data: {
      labels: ['Happy', 'Neutral', 'Impatient', 'Frustrated'],
      datasets: [{
        data: [12, 24, 4, 1],
        backgroundColor: ['#10b981', '#06b6d4', '#f59e0b', '#ef4444'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#9ca3af' }
        }
      }
    }
  });
}

function updateChartsData() {
  if (!charts.traffic || !charts.sentiment) return;
  
  // Count sentiments
  let happy = 0, neutral = 0, impatient = 0, frustrated = 0;
  orders.forEach(o => {
    const s = o.sentiment ? o.sentiment.toLowerCase() : "neutral";
    if (s === "happy") happy++;
    else if (s === "impatient") impatient++;
    else if (s === "frustrated") frustrated++;
    else neutral++;
  });
  
  charts.sentiment.data.datasets[0].data = [happy, neutral, impatient, frustrated];
  charts.sentiment.update();
}

// UI Badges/Stats updates
function updateOrderCountBadge() {
  const count = orders.length;
  document.getElementById("header-total-orders").innerText = `${count} Orders today`;
}

function updateQuickStats() {
  let totalSales = 0;
  orders.forEach(o => {
    totalSales += o.total;
  });
  
  document.getElementById("stats-total-today").innerText = `£${totalSales.toFixed(2)}`;
  document.getElementById("stats-count-today").innerText = orders.length;
  document.getElementById("stats-avg-duration").innerText = "42s";
}

// String Formatting helper
function capitalizeFirstLetter(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function togglePasswordVisibility(fieldId) {
  const el = document.getElementById(fieldId);
  if (el.type === "password") {
    el.type = "text";
  } else {
    el.type = "password";
  }
}

// Fallback HTTP polling for Serverless environments (like Vercel) where WebSockets are unsupported
let isPollingActive = false;
setInterval(async () => {
  if (isPollingActive) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    isPollingActive = true;
    try {
      // Poll active calls
      const activeResponse = await fetch(`${apiUrl}/active-calls`);
      if (activeResponse.ok) {
        const activeCallsData = await activeResponse.json();
        const callSids = Object.keys(activeCallsData);
        
        if (callSids.length > 0) {
          const firstCallSid = callSids[0];
          const callData = activeCallsData[firstCallSid];
          updateCallStateFromData(firstCallSid, callData);
        } else {
          if (activeCall) {
            await handleCallCompletion(activeCall.sid);
          }
        }
      }
    } catch (e) {
      console.warn("Polling fallback error:", e);
    } finally {
      isPollingActive = false;
    }
  }
}, 3000);

// Helper to manually sync active call state when WebSockets are unsupported
async function syncActiveCallStatus(sid) {
  try {
    const response = await fetch(`${apiUrl}/active-calls`);
    if (response.ok) {
      const activeCallsData = await response.json();
      if (activeCallsData[sid]) {
        updateCallStateFromData(sid, activeCallsData[sid]);
      } else {
        await handleCallCompletion(sid);
      }
    }
  } catch (e) {
    console.error("Error syncing active call status:", e);
  }
}

// Helper to update activeCall state and UI from call details
function updateCallStateFromData(sid, callData) {
  let initialCallSetup = false;
  if (!activeCall) {
    // Start call
    activeCall = {
      sid: sid,
      phone: callData.phone,
      chat_history: callData.chat_history || [],
      cart: callData.cart || [],
      customer_info: callData.customer_info || { name: "", address: "", type: "" },
      sentiment: callData.sentiment || "neutral",
      language: callData.language || "en-GB"
    };
    document.getElementById("no-call-container").classList.add("hidden-element");
    document.getElementById("active-call-container").classList.remove("hidden-element");
    document.getElementById("call-phone-number").innerHTML = `<i class="fa-solid fa-phone"></i> ${callData.phone}`;
    startCallTimer();
    initialCallSetup = true;
  }
  
  // Check if chat history length changed before re-rendering/speaking
  const oldHistoryLen = activeCall.chat_history ? activeCall.chat_history.length : 0;
  const newHistoryLen = callData.chat_history ? callData.chat_history.length : 0;
  const chatHistoryChanged = oldHistoryLen !== newHistoryLen;
  
  activeCall.chat_history = callData.chat_history;
  activeCall.cart = callData.cart;
  activeCall.customer_info = callData.customer_info;
  activeCall.sentiment = callData.sentiment;
  activeCall.language = callData.language;
  
  if (chatHistoryChanged || initialCallSetup) {
    const chatHistoryContainer = document.getElementById("call-chat-history");
    chatHistoryContainer.innerHTML = "";
    activeCall.chat_history.forEach(turn => {
      const userBubble = document.createElement("div");
      userBubble.className = "bubble bubble-user";
      userBubble.innerHTML = `<span class="speaker-tag">Customer</span> ${turn.user}`;
      chatHistoryContainer.appendChild(userBubble);
      
      const aiBubble = document.createElement("div");
      aiBubble.className = "bubble bubble-ai";
      aiBubble.innerHTML = `<span class="speaker-tag">AI Agent</span> ${turn.ai}`;
      chatHistoryContainer.appendChild(aiBubble);
    });
    chatHistoryContainer.scrollTop = chatHistoryContainer.scrollHeight;
    
    // Aloud AI voice speaking (skip on first greeting simulation to avoid double beeps, let startActiveCall handle it)
    if (chatHistoryChanged && newHistoryLen > 0) {
      const lastTurn = activeCall.chat_history[newHistoryLen - 1];
      speakTextInBrowser(lastTurn.ai, activeCall.language, () => {
        if (activeCall && activeCall.sid.startsWith("mic_")) {
          runMicLoop(activeCall.sid);
        }
      });
    }
  }
  
  // Render cart
  renderActiveCart();
  
  const sentimentBadge = document.getElementById("call-sentiment-badge");
  sentimentBadge.className = `badge-sentiment ${activeCall.sentiment}`;
  let emoji = "meh";
  if (activeCall.sentiment === "happy") emoji = "smile";
  else if (activeCall.sentiment === "impatient") emoji = "hourglass-half";
  else if (activeCall.sentiment === "frustrated") emoji = "angry";
  sentimentBadge.innerHTML = `<i class="fa-solid fa-${emoji}"></i> ${capitalizeFirstLetter(activeCall.sentiment)}`;
  
  document.getElementById("call-detected-lang").innerText = activeCall.language;
}

// Helper to complete or terminate active call
async function handleCallCompletion(sid) {
  if (activeCall && activeCall.sid === sid) {
    // Fetch orders to see if the call was completed as an order
    try {
      const ordersResponse = await fetch(`${apiUrl}/orders`);
      if (ordersResponse.ok) {
        const latestOrders = await ordersResponse.json();
        const matchingOrder = latestOrders.find(o => o.id === sid);
        if (matchingOrder) {
          orders = latestOrders;
          completeActiveCall(matchingOrder);
          return;
        }
      }
    } catch(e) {
      console.error("Error fetching orders during call completion:", e);
    }
    
    // Hung up without completing order
    activeCall = null;
    stopCallTimer();
    document.getElementById("active-call-container").classList.add("hidden-element");
    document.getElementById("no-call-container").classList.remove("hidden-element");
  }
}

// Web Speech API Voice Synthesis for Call Simulation
function speakTextInBrowser(text, langCode, onEndCallback) {
  if (!window.speechSynthesis) {
    console.warn("Speech synthesis not supported in this browser.");
    return;
  }
  
  window.speechSynthesis.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  
  let cleanLang = langCode || 'en-GB';
  if (cleanLang.includes('-')) {
    const parts = cleanLang.split('-');
    cleanLang = parts[0] + '-' + parts[1].toUpperCase();
  }
  utterance.lang = cleanLang;
  
  const voices = window.speechSynthesis.getVoices();
  const matchingVoice = voices.find(v => v.lang.startsWith(cleanLang.substring(0, 2)));
  if (matchingVoice) {
    utterance.voice = matchingVoice;
  }
  
  utterance.rate = 1.0;
  
  if (onEndCallback) {
    utterance.onend = onEndCallback;
  }
  
  window.speechSynthesis.speak(utterance);
}

// Browser Microphone Voice Agent (No Twilio)
let micSpeechRecognition = null;
let isMicListening = false;

function startBrowserMicAgent() {
  if (activeCall) {
    alert("An active call is already running!");
    return;
  }
  
  const mockSid = "mic_" + Math.random().toString(36).substring(2, 10);
  const mockFrom = "Browser Mic";
  
  // Start session on backend
  fetch(`${httpProtocol}//${serverHost}/voice/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `CallSid=${mockSid}&From=${encodeURIComponent(mockFrom)}`
  }).then(() => {
    // Start active call locally
    startActiveCall(mockSid, mockFrom);
  });
}

function runMicLoop(sid) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Your browser does not support Speech Recognition. Please use Google Chrome or Microsoft Edge.");
    return;
  }
  
  if (micSpeechRecognition) {
    try { micSpeechRecognition.stop(); } catch(e){}
  }
  
  const recognition = new SpeechRecognition();
  micSpeechRecognition = recognition;
  
  recognition.continuous = false;
  recognition.interimResults = false;
  
  recognition.lang = activeCall && activeCall.language ? activeCall.language : 'en-GB';
  
  const statusText = document.getElementById("server-status");
  
  recognition.onstart = () => {
    isMicListening = true;
    if (statusText) {
      statusText.className = "status-indicator connected";
      statusText.querySelector(".text").innerHTML = "<i class='fa-solid fa-microphone blink-animation text-danger'></i> Listening to Mic...";
    }
    console.log("Mic recording started...");
  };
  
  recognition.onend = () => {
    isMicListening = false;
    if (statusText) {
      statusText.className = "status-indicator connected";
      statusText.querySelector(".text").innerText = "Processing speech...";
    }
  };
  
  recognition.onerror = (e) => {
    console.error("Mic error:", e);
    isMicListening = false;
    
    // If the error was no-speech, we wait and reopen mic if call is still active
    if (activeCall && activeCall.sid === sid) {
      setTimeout(() => {
        if (activeCall && activeCall.sid === sid && !isMicListening) {
          runMicLoop(sid);
        }
      }, 2000);
    }
  };
  
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    console.log("Mic speech result:", transcript);
    
    // Add user bubble instantly on UI
    const chatHistory = document.getElementById("call-chat-history");
    const waitMsg = chatHistory.querySelector(".system-message");
    if (waitMsg) waitMsg.remove();
    
    const userBubble = document.createElement("div");
    userBubble.className = "bubble bubble-user";
    userBubble.innerHTML = `<span class="speaker-tag">Customer</span> ${transcript}`;
    chatHistory.appendChild(userBubble);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    
    // Send to backend
    fetch(`${httpProtocol}//${serverHost}/voice/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `CallSid=${sid}&SpeechResult=${encodeURIComponent(transcript)}`
    }).then(async () => {
      // Sync state immediately in polling mode
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        await syncActiveCallStatus(sid);
      }
    });
  };
  
  recognition.start();
}


