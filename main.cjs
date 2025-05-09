const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const https = require('https');
const path = require('path');
const carbone = require('carbone');
const fs = require('fs');
const util = require('util');
const url = require('url');
const converter = require('./node_modules/carbone/lib/converter');
//const converter = require('./carbone-converter.cjs');
const log = require ('electron-log');

// Require `PhoneNumberFormat`.
const PNF = require('google-libphonenumber').PhoneNumberFormat;
// Get an instance of `PhoneNumberUtil`.
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();

require('dotenv').config();

// Optional, initialize the logger for any renderer process
log.initialize();

log.info('Starting contract generator');

// run this as early in the main process as possible
if (require('electron-squirrel-startup')) app.quit();

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('src/index.html');

  // Open the DevTools.
  // win.webContents.openDevTools();
};

async function handleFileOpen() {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (!canceled) {
    return filePaths[0];
  }
}
const renderAsync = util.promisify(carbone.render);

async function handleRenderPdf(event, data) {
  log.info('Rendering PDF with data:', data);
  const extension = 'pdf';
  // const extension = 'odt'
  var options = {
    convertTo: extension,
  };
  var templateName = data.contractType == 'addendum' ? 'template-addendum.odt' : 'template-ontlening.odt';
  var templatePath = path.join(__dirname, 'resources', templateName);
  // template file path input
  try {
    const result = await renderAsync(templatePath, data, options);
    const pathDirectory = data.generationInfo.path.trim().length === 0 ? '.' : data.generationInfo.path;
    let fileName = data.contractNumber.trim().length === 0 ? 'contract' : data.contractNumber;
    if (data.contractType == 'addendum') {
     const today = new Date();
     const formattedDate = formatDateYYYYMMDD(today);
     fileName += '-addendum-' + formattedDate;
    }
    fileName += '.' + extension;
    const filePath = path.join(pathDirectory, fileName);
    fs.writeFileSync(filePath, result);
    const fileUrl = url.pathToFileURL(filePath);
    log.info('path: ' + url.fileURLToPath(fileUrl));
    return fileUrl.href;
  } catch (err) {
    log.error('Error generating PDF:', err);
    throw err;
  }
}

function formatDateYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2); // Add leading zero if needed
  const day = ('0' + date.getDate()).slice(-2); // Add leading zero if needed
  return `${year}${month}${day}`;
}

/** Validates and formats phone numbers, according to standard Belgian formatting.
 * If invalid, returns empty string. If valid, returns formatted phone number.*/
function formatPhoneNumber(e, rawPhoneNumber) {
  let phoneNumber;

  try {
    phoneNumber = phoneUtil.parse(rawPhoneNumber, 'BE');
  } catch {
    return ""
  }

  if (!phoneUtil.isValidNumber(phoneNumber)) {
    return ""
  }

  if (phoneUtil.isValidNumberForRegion(phoneNumber, "BE")) {
    return phoneUtil.format(phoneNumber, PNF.NATIONAL)
  } else {
    return phoneUtil.format(phoneNumber, PNF.INTERNATIONAL)
  }
}

async function handleGetAsset(event, data) {
  console.log('Fetching asset data for tag:', data.assetTag);

  if (data.assetTag === undefined || data.assetTag === '') {
    return {
      success: false,
      error: 'Asset tag is required'
    }
  }

  if (!process.env.INVENTORY_API_KEY) {
    return {
      success: false,
      error: 'Please configure API key'
    }
  }
  
  return fetchInventoryData(data.assetTag)
  .then((data) => {
    console.log('Inventory data:', data);
    return {
      success: true,
      asset: {
        asset_tag: data.asset_tag,
        brand: data.manufacturer.name,
        model: data.model_number,
        serial: data.serial,
      }
    };
  })
  .catch((error) => {
    console.error('Error fetching inventory data:', error);
    return {
      success: false,
      error: error.message
    }
  });
}

function fetchInventoryData(assetTag) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.INVENTORY_API_HOST,
      path: '/api/v1/hardware/bytag/' + assetTag,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.INVENTORY_API_KEY,
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      // A chunk of data has been received.
      res.on('data', (chunk) => {
        data += chunk;
      });

      // The whole response has been received.
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else if (res.statusCode === 404) {
          reject(new Error('Asset not found'));
        } else {
          reject(new Error(`Request failed with status code ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

async function openExternal(e, url) {
  console.log(url);
  shell.openExternal(url);
}

app.whenReady().then(() => {
  ipcMain.handle('dialog:openFile', handleFileOpen);
  ipcMain.handle('generatePdf', handleRenderPdf);
  ipcMain.handle('getAsset', handleGetAsset)
  ipcMain.handle('formatPhoneNumber', formatPhoneNumber);
  ipcMain.handle('openExternal', openExternal)
  createWindow();

  app.on('activate', () => {
    log.info('activate event triggered');
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // FIXME: when converting to PDF, a 'busy' error is thrown at exit (probably from libreoffice?)
  //process.exit(); // to kill automatically LibreOffice workers

  if (process.platform !== 'darwin') {
    try {
      converter.exit(() => {
        log.info('Carbone converter exited');
        log.info('Quitting contract generator');
        app.quit();
      });
    } catch (err) {
      log.error('Error closing Carbone:', err);
    }
  }
});
