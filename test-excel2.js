const ExcelJS = require('exceljs');
const fs = require('fs');

async function test() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Test');
  
  // Make a small 100x100 jpeg image base64
  const base64Jpg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const imgBuffer = Buffer.from(base64Jpg, 'base64');
  
  const imgId = workbook.addImage({
    buffer: imgBuffer,
    extension: 'jpeg'
  });

  sheet.addImage(imgId, {
    tl: { col: 0, row: 0 },
    ext: { width: 100, height: 100 },
    editAs: 'absolute'
  });

  sheet.addImage(imgId, {
    tl: { col: 2, row: 0 },
    ext: { width: 100, height: 100 },
    editAs: 'oneCell'
  });

  sheet.addImage(imgId, {
    tl: { col: 4, row: 0 },
    br: { col: 6, row: 2 } // using range instead of ext
  });

  await workbook.xlsx.writeFile('test-images.xlsx');
  console.log('Saved test-images.xlsx');
}

test().catch(console.error);
