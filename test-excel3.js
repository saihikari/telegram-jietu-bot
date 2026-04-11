const ExcelJS = require('exceljs');
const fs = require('fs');

async function test() {
  const workbook = new ExcelJS.Workbook();
  const detailSheet = workbook.addWorksheet('Test');
  
  // Make a small 100x100 jpeg image base64
  const base64Jpg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  fs.writeFileSync('temp.jpg', Buffer.from(base64Jpg, 'base64'));
  
  let currentRow = 1;
  const imgWidth = 100;
  const imgHeight = 100;
  const spannedRows = Math.ceil(imgHeight / 20) + 1; // 6

  const imageId = workbook.addImage({
    buffer: fs.readFileSync('temp.jpg'),
    extension: 'jpeg'
  });

  // Attempt the exact code from our script
  detailSheet.addImage(imageId, {
    tl: { col: 0, row: currentRow - 1 },
    br: { col: 10, row: currentRow - 1 + spannedRows - 1 },
    editAs: 'oneCell'
  });

  await workbook.xlsx.writeFile('test-images3.xlsx');
  console.log('Saved test-images3.xlsx');
}

test().catch(console.error);
