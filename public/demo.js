const $ = selector => document.querySelector(selector);
const catalog = [
  { name: 'Notebook', category: 'Office', price: 80 },
  { name: 'Desk lamp', category: 'Office', price: 950 },
  { name: 'Keyboard', category: 'Electronics', price: 1800 },
  { name: 'USB cable', category: 'Electronics', price: 250 }
];

async function loadTasks() {
  const response = await fetch('/api/demo/tasks');
  if (!response.ok) throw new Error('Could not load saved tasks');
  const data = await response.json();
  $('#task-list').replaceChildren();
  for (const task of data.tasks) {
    const item = document.createElement('li');
    item.textContent = task.title + ' — ' + task.priority;
    $('#task-list').append(item);
  }
}

$('#task-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('#task-form button');
  button.disabled = true;
  try {
    const response = await fetch('/api/demo/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('#task-title').value, priority: $('#priority').value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    await loadTasks();
    $('#feedback').textContent = 'Saved: ' + data.title;
    $('#task-title').value = '';
  } catch (error) { $('#feedback').textContent = error.message; }
  finally { button.disabled = false; }
};

function showProducts(query = '') {
  const matches = catalog.filter(item => (item.name + ' ' + item.category).toLowerCase().includes(query.toLowerCase()));
  $('#products').replaceChildren();
  for (const product of matches) {
    const row = document.createElement('tr');
    for (const value of [product.name, product.category, product.price]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    $('#products').append(row);
  }
  $('#search-feedback').textContent = matches.length + ' resources found';
}

$('#search-form').onsubmit = event => { event.preventDefault(); showProducts($('#search').value); };
$('#refresh-tasks').onclick = () => loadTasks().catch(error => { $('#feedback').textContent = error.message; });
for (const name of ['tasks', 'catalog', 'notes', 'invoices']) {
  $('#tab-' + name).onclick = () => {
    for (const section of ['tasks', 'catalog', 'notes', 'invoices']) {
      $('#' + section).hidden = section !== name;
      $('#tab-' + section).setAttribute('aria-pressed', String(section === name));
    }
    location.hash = name;
  };
}
loadTasks().catch(error => { $('#feedback').textContent = error.message; });
showProducts();

async function loadInvoices() {
  const response = await fetch('/api/demo/invoices');
  if (!response.ok) throw new Error('Could not load saved invoices');
  const { invoices } = await response.json();
  $('#invoice-list').replaceChildren();
  for (const invoice of invoices) {
    const row = document.createElement('tr');
    for (const key of ['company', 'invoiceNumber', 'invoiceDate', 'amount', 'currency', 'dueDate', 'source']) {
      const cell = document.createElement('td');
      cell.textContent = invoice[key];
      row.append(cell);
    }
    $('#invoice-list').append(row);
  }
  $('#invoice-count').textContent = invoices.length + ' saved invoice(s)';
}

$('#invoice-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('#invoice-form button');
  button.disabled = true;
  try {
    const response = await fetch('/api/demo/invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: $('#invoice-company').value, invoiceNumber: $('#invoice-number').value, invoiceDate: $('#invoice-date').value, amount: $('#invoice-amount').value, currency: $('#invoice-currency').value, dueDate: $('#invoice-due').value, source: $('#invoice-source').value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $('#invoice-feedback').textContent = 'Saved invoice ' + data.invoiceNumber;
    $('#invoice-form').reset();
    await loadInvoices();
  } catch (error) { $('#invoice-feedback').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#refresh-invoices').onclick = () => loadInvoices().catch(error => { $('#invoice-feedback').textContent = error.message; });
loadInvoices().catch(error => { $('#invoice-feedback').textContent = error.message; });
const initialSection = location.hash.slice(1);
if (['tasks', 'catalog', 'notes', 'invoices'].includes(initialSection)) $('#tab-' + initialSection).click();
