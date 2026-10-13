const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const xml2js = require('xml2js');
const cors = require('cors');
const bodyParser = require('body-parser');
const jsonexport = require('jsonexport');
const mysql = require('mysql2');
const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { Parser } = require('json2csv');




const app = express();
const upload = multer({ dest: 'uploads/' });

const session = require('express-session');

// Configure session middleware
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false
}));


// Apply requireAuth middleware to routes that require authentication
//app.use(['/addUser', '/save-details', '/upload', '/logout', '/getUploadedScorms', '/getCourseList', '/updateUserSCORMData'], requireAuth);


// Serve user photos statically
app.use('/photos', express.static(path.join(__dirname, 'public/photos')));

const currentDate = new Date().toLocaleDateString('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
})
// .replace(/\//g, '');

const currentTime = new Date().toLocaleTimeString('en-US', {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
})
// .replace(/:/g, '');

// Enable CORS for all routes
app.use(cors());

app.get('/addUser', (req, res) => {
  res.render('addUser.html', { currentDate, currentTime });
});


app.use(bodyParser.json({ limit: '2500mb' }));
app.use(bodyParser.urlencoded({ limit: '2500mb', extended: true }));

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'yyPL@123456',
  database: 'yymahindra',
  authPlugin: 'mysql_native_password',
});


// Serve static files (like index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Serve specific SCORM package content based on selected folder
app.use('/scorm/:folderName', express.static(path.join(__dirname, 'uploads')));

// Adding new line for training video
app.use("/uploads", express.static(path.join(__dirname, "uploads")));


// Serve extracted SCORM content statically
app.use('/scorm', express.static(path.join(__dirname, 'uploads')));

app.use('/js', express.static(path.join(__dirname, 'public/js')));

// Serve home.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});



// Serve index.html for both root and "/courses" routes
app.get(['/courses'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

//app.set('view engine', 'ejs');


//User information upload
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public/photos'),
  filename: (req, file, callback) => {
    // Use the filename already created by the frontend
    callback(null, file.originalname);
  }
});

const uploadMysql = multer({ storage: storage });



// Set up storage for uploaded files in 'Excel Assessment' folder
const uploadExcelAssessment = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "Excel Assessment");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const uploadExcelAss = multer({ storage: uploadExcelAssessment });



const uploadExcelTrainingAssStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "Training Assessment", "Pretest assessment");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const uploadExcelTrainingAss = multer({ storage: uploadExcelTrainingAssStorage });

const uploadVideoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoDir = path.join(__dirname, "uploads", "Training Assessment", "Videos");
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
    cb(null, videoDir);
  },
  filename: (req, file, cb) => {
    const { courseID } = req.body;
    cb(null, `${courseID}_video`);
  },
});

const uploadVideo = multer({ storage: uploadVideoStorage });


const uploadFiles = multer().fields([
  { name: "mcqFile", maxCount: 1 },
  { name: "videoFile", maxCount: 1 },
]);

// app.post('/save-details', async (req, res) => {
//   let { name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, Contract, uRole, courseTags, Qualification } = req.body;

//   const uniqueID = uuidv4(); 

//   // --- CRITICAL CHANGE 4: Get the filename from the request body ---
//   const photoFileName = req.body.photoFileName || 'default.png'; // Use the filename passed from the frontend
//   const photo_filename = path.join(__dirname, 'public', 'photos', photoFileName); // This is correct, but the variable is now 'photoFileName'

//   console.log(Qualification);
//   const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
//   const myCurrentTime = new Date().toLocaleTimeString('en-US', {});
//   const userInfo = { uniqueID, employeeID, name }; 

//   try {
//     // Step 1: Insert user data into the main user table
//     await connection.promise().query(
//       // --- CRITICAL CHANGE 5: Replace the undefined 'fileName' with 'photoFileName' ---
//       'INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, courseTags,Contract ,Qualification) VALUES (NULL, ?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)',
//       [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photoFileName, photo_filename, myCurrentDate, myCurrentTime, JSON.stringify(courseTags), Contract, Qualification]
//       //                                                                                         ^ Change this to photoFileName
//     );
//     // ... (rest of the code is fine) ...
//   } catch (error) {
//     console.error('Error saving user and course data:', error);
//     res.status(500).json({ error: 'An error occurred while saving user and course data' });
//   }
// });




app.post('/save-details', async (req, res) => {
  let {
    name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth,
    address, mobileNo, department, Contract, uRole, level, Qualification
  } = req.body;

  const uniqueID = uuidv4();

  // --- CRITICAL CHANGE 4: Get the filename from the request body ---
  const photoFileName = req.body.photoFileName || 'default.png'; // filename passed from frontend
  const photo_filename = path.join(__dirname, 'public', 'photos', photoFileName);

  console.log(Qualification);

  const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
  const myCurrentTime = new Date().toLocaleTimeString('en-US', {});
  const userInfo = { uniqueID, employeeID, name };

  try {
    // Step 1: Insert user data into the main user table
    await connection.promise().query(
      'INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, level, Contract, Qualification) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uniqueID, name, emailID, employeeID, uName, uPass,
        dateOfJoining, dateOfBirth, address, mobileNo, department,
        uRole, photoFileName, photo_filename, myCurrentDate,
        myCurrentTime, level, Contract, Qualification
      ]
    );

    // ✅ FIX: Send a proper success response
    res.json({
      success: true,
      message: "User uploaded successfully!",
      uploadedUser: { uniqueID, employeeID, name, photoFileName }
    });

  } catch (error) {
    console.error('Error saving user and course data:', error);
    res.status(500).json({ error: 'An error occurred while saving user and course data' });
  }
});


app.post('/save-photo', uploadMysql.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No photo uploaded' });
  }
  console.log('Photo uploaded successfully:', req.file.filename);
  res.status(200).json({ success: true, filename: req.file.filename });
});






//New User Sign Up
// app.post('/sign-up', (req, res) => {
//   let { name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, courseTags } = req.body;

//   const uniqueID = uuidv4(); // Generate a unique ID

//   const sanitizedName = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
//   const fileName = `${sanitizedName}_${currentDate}_${currentTime}.png`;
//   const photo_filename = `D:/Parallel learning/Jsapp/LMS and ARS/R4_13-12-2024/R4_Tetrapak LMS (11-12-2024 8.15pm)/public/photos/${fileName}`; // Construct the photo path
//   // const userID = <%= id %>;

//   const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
//   const myCurrentTime = new Date().toLocaleTimeString('en-US', {});

//   const query = `INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, courseTags) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
//   connection.query(query, [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, fileName, photo_filename, myCurrentDate, myCurrentTime, JSON.stringify(courseTags)], (error, results) => {
//     if (error) throw error;
//     console.log('User details saved successfully');
//     console.log(query);

//     res.redirect('/userlogin.html');
//   });
// });

app.post('/sign-up', async (req, res) => {
  let { name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, level, Contract } = req.body;

  const uniqueID = uuidv4(); // Generate a unique ID

  const sanitizedName = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  const fileName = `${sanitizedName}_${currentDate}_${currentTime}.png`;
  const photo_filename = `/public/photos/${fileName}`; // Construct the photo path
  // const userID = <%= id %>;

  const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
  const myCurrentTime = new Date().toLocaleTimeString('en-US', {});
  const userInfo = { uniqueID, employeeID, name }; // The data to insert into course tables

  try {
    // Step 1: Insert user data into the main user table
    await connection.promise().query(
      'INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, level ,Contract ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, fileName, photo_filename, myCurrentDate, myCurrentTime, JSON.stringify(level), Contract]
    );

    // Step 2: Retrieve courseIDs from the courses table based on the selected tags
    const [courses] = await connection.promise().query(`
      SELECT courseID
      FROM courses
      WHERE ${level.map(tag => `FIND_IN_SET(?, level)`).join(' OR ')}`,
      level
    );

    // Step 3: For each courseID, insert the user data into the respective course table
    for (let course of courses) {
      const courseTableName = `course_${course.courseID}`;
      await connection.promise().query(`INSERT INTO ${courseTableName} (uniqueID, employeeID, name) VALUES (?, ?, ?)`, [uniqueID, employeeID, name]);
    }
    //res.sendStatus(200);
    res.redirect('/userlogin.html');

    //res.status(200).json({ message: 'User and course data saved successfully' });
  } catch (error) {
    console.error('Error saving user and course data:', error);
    res.status(500).json({ error: 'An error occurred while saving user and course data' });
  }

  /*const query = `INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, courseTags, photo, photo_filename, currentDate, currentTime) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  connection.query(query, [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, courseTags, fileName, photo_filename, myCurrentDate, myCurrentTime], (error, results) => {
    if (error) throw error;
    console.log('User details saved successfully');
    //res.redirect('/home.html');
  });*/

});






// Query to get course IDs where courseTags match any of the selected tags
/*const getCoursesQuery = `
  SELECT courseID 
  FROM courses 
  WHERE FIND_IN_SET('Safety', courseTags) > 0 
    OR FIND_IN_SET('Development', courseTags) > 0
`;

// Adjust the query dynamically to include all selected courseTags
const selectedTags = courseTags.map(tag => `FIND_IN_SET('${tag}', courseTags) > 0`).join(' OR ');
const getCoursesQueryUpdate = `
  SELECT courseID 
  FROM courses 
  WHERE ${selectedTags}
`;

// Execute the query to get matching course IDs
connection.query(getCoursesQueryUpdate, (err, results) => {
  if (err) {
    console.error("Error fetching course IDs:", err);
    return res.status(500).send("Error retrieving courses");
  }
  const courseIDs = results.map(row => row.courseID);

  // Pass courseIDs to the next step for adding user info
  insertUserToCourseTables(courseIDs);
});*/






// Endpoint to verify username uniqueness
app.post('/verify-username', (req, res) => {
  const { uName } = req.body;

  const query = 'SELECT COUNT(*) AS count FROM users WHERE uName = ?';
  connection.query(query, [uName], (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    } else {
      const count = result[0].count;
      if (count > 0) {
        res.json({ exists: true });
      } else {
        res.json({ exists: false });
      }
    }
  });
});




//route for the verifyint the name of user

app.post('/verify-name', (req, res) => {
  console.log('Received name:', req.body.name);
  const { name } = req.body;

  const query = 'SELECT COUNT(*) AS count FROM users WHERE name = ?';
  connection.query(query, [name], (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    } else {
      const count = result[0].count;
      if (count > 0) {
        res.json({ exists: true });
      } else {
        res.json({ exists: false });
      }
    }
  });
});







// Route to fetch course tags
app.get('/get-course-tags', (req, res) => {
  const query = 'SELECT DISTINCT level FROM courses';
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching course tags:', error);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      let tags = [];
      results.forEach(row => {
        if (row.level) { // Check if courseTags is not null
          const rowTags = row.level.split(',').map(tag => tag.trim());
          tags = tags.concat(rowTags);
        }
      });
      tags = [...new Set(tags)]; // Remove duplicates
      res.json(tags);
    }
  });
});






// Upload the scorm on the lms
app.post('/upload', upload.single('scormFile'), (req, res) => {
  // Handle uploaded file here
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }
  const uploadPath = `uploads/Scorm_${Date.now()}`; // Folder for the uploaded SCORM file
  fs.mkdirSync(uploadPath); // Create a directory for the uploaded SCORM

  // Extract the SCORM content to the specific folder
  const zip = new AdmZip(req.file.path);
  const extractPath = uploadPath;

  zip.extractAllTo(extractPath, true);

  // Extract course data from the request body
  let { courseName, courseDescription, courseDate, courseID, level, department } = req.body;

  // Set courseTags to "default" if it is not provided
  if (!level || level.trim() === '') {
    level = 'default';
  }

  // Insert course data into the courses table
  const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, department) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, level, department], (error, results) => {
    if (error) {
      console.error('Error saving course data:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Course data saved successfully');

    // Dynamically create column definitions
    let columnDefinitions = `
      id INT AUTO_INCREMENT PRIMARY KEY,
      uniqueID VARCHAR(255) NOT NULL,
      employeeID TEXT,
      name TEXT,
      noOfAttempts INT DEFAULT 0
    `;

    for (let i = 1; i <= 27; i++) {
      columnDefinitions += `,
        course_${courseID}_Posttest${i} LONGTEXT,
        score${i} LONGTEXT,
        status${i} LONGTEXT,
        duration${i} LONGTEXT,
        date${i} TEXT
      `;
    }

    const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;


    connection.query(createTableQuery, (err) => {
      if (err) {
        console.error('Error creating course table:', err);
        return res.status(500).send('Error creating course table');
      }
      console.log(`Table course_${courseID} created successfully`);

      // Query the users table to get uniqueID, employeeID, and name
      // const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

      // connection.query(selectUsersQuery, (err, users) => {
      //   if (err) {
      //     console.error('Error fetching users data:', err);
      //     return res.status(500).send('Error fetching users data');
      //   }

      //   // Insert data into course_${courseID} table
      //   const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
      //   const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

      //   connection.query(insertUserData, [userData], (err) => {
      //     if (err) {
      //       console.error('Error inserting user data:', err);
      //       return res.status(500).send('Error inserting user data');
      //     }
      //     console.log(`User data inserted into course_${courseID} successfully`);

      //     // Send JavaScript response to show alert message and redirect back to the upload page
      //     const script = `
      //       <script>
      //         const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
      //         if (uploadConfirmation) {
      //             window.location.href = '/'; // Redirect to the upload page
      //         }
      //       </script>
      //     `;
      //     res.send(script);
      //   });
      // });
    });
    const script = `
           <script>
              const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
             if (uploadConfirmation) {
                 window.location.href = '/'; // Redirect to the upload page
              }
             </script>
           `;
    res.send(script);
  });
});



// // Serve SCORM content based on selected folder
// app.get('/scorm/:folderName', (req, res) => {
//   const folderName = req.params.folderName;
//   const filePath = path.join(__dirname, 'uploads', folderName, 'story.html');

//   fs.access(filePath, fs.constants.F_OK, (err) => {
//     if (err) {
//       console.error(err);
//       res.status(404).send('File not found');
//     } else {
//       res.sendFile(filePath);
//     }
//   });
// });


// Serve SCORM content based on selected folder
app.get('/scorm/:folderName', (req, res) => {
  const folderName = req.params.folderName;
  const primaryFilePath = path.join(__dirname, 'uploads', folderName, 'story.html');
  const alternateFilePath = path.join(__dirname, 'Excel Assessment', 'Assessment pages', `${folderName}_quiz.html`);

  fs.access(primaryFilePath, fs.constants.F_OK, (err) => {
    if (err) {
      // Primary file does not exist, check the alternate path
      fs.access(alternateFilePath, fs.constants.F_OK, (altErr) => {
        if (altErr) {
          console.error(`File not found in either location: ${primaryFilePath} or ${alternateFilePath}`);
          res.status(404).send('File not found');
        } else {
          res.sendFile(alternateFilePath);
        }
      });
    } else {
      res.sendFile(primaryFilePath);
    }
  });
});



let currentCourseID;


// Get the scorm and open it
app.get('/getScorms', (req, res) => {
  // First, execute the database query to get the latest course name
  const query = `SELECT * FROM courses ORDER BY id DESC`;
  connection.query(query, (error, results) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error');
    }

    // Extract the course name from the query results
    //const courseName = results[0].courseName;
    if (results.length > 0 && results[0].courseName) {
      const courseName = results[0].courseName;
      currentCourseID = results[0].courseID;
      const courseID = results[0].courseID;

      const scormsDir = path.join(__dirname, 'uploads');
      fs.readdir(scormsDir, (err, files) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Internal Server Error');
        } else {
          // Extract the list of SCORM folders
          const scormFolders = files.filter(file => {
            return fs.statSync(path.join(scormsDir, file)).isDirectory();
          });
          const scormsData = results.map(row => ({
            courseID: row.courseID,
            courseName: row.courseName,
            folderName: row.uploadPath // Assuming this is the field where SCORM folder name is stored
          }));

          // Send the response with both the course name and SCORM folders
          res.json({ courseID, courseName, scormFolders, scormsData });
        }
      });
      // Proceed with the rest of your code
    } else {
      const courseName = "Undefined";
      // Handle the case where no results are returned or courseName is undefined
    }

    // Now, read the list of uploaded SCORM packages from the file system

  });
});


// get the uploaded scorm list on viewscorm page
app.get('/getUploadedScorms', (req, res) => {
  const scormsDir = path.join(__dirname, 'uploads');
  const query = `SELECT courseName, scormPath FROM courses ORDER BY id DESC`;
  fs.readdir(scormsDir, (err, files) => {
    if (err) {
      console.error(err);
      res.status(500).send('Internal Server Error');
    } else {
      const scormFolders = files.filter(file => {
        return fs.statSync(path.join(scormsDir, file)).isDirectory();
      }).map(folder => ({
        folderName: folder,
        folderPath: path.join(scormsDir, folder)
      }));
      res.json(scormFolders);
    }
  });
});


//Get the course list on courseManagemnet page
app.get('/getCourseList', (req, res) => {
  const query = `SELECT id, courseName, courseDate, courseDescription, department, level, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;
  connection.query(query, (error, results) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error');
    }
    res.json(results);
  });
});



// // Get the course list on viewscorm page
// app.get('/getViewscormCourseList', (req, res) => {
//   const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;

//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error(error);
//       return res.status(500).send('Internal Server Error');
//     }

//     // Filter the courses based on whether the scormPath exists in the uploads folder
//     const filteredResults = results.filter(course => {
//       const scormFolderPath = path.join(__dirname, course.scormPath); // Full path to the SCORM folder
//       return fs.existsSync(scormFolderPath); // Only keep courses where the folder exists
//     });

//     res.json(filteredResults); // Send the filtered results
//   });
// });




// // Get the course list on viewscorm page
// app.get('/getViewscormCourseList', (req, res) => {
//   const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;

//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error(error);
//       return res.status(500).send('Internal Server Error');
//     }

//     // Filter the courses based on whether the scormPath exists in the uploads folder
//     const filteredResults = results.filter(course => {
//       const scormFolderPath = path.join(__dirname, course.scormPath); // Full path to the SCORM folder
//       return fs.existsSync(scormFolderPath); // Only keep courses where the folder exists
//     });

//     res.json(filteredResults); // Send the filtered results
//   });
// });


// Get the course list on viewscorm page woking 3/10/2025
// app.get('/getViewscormCourseList', (req, res) => {
//   const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;
//   const uniqueID = req.session.user.uniqueID; // Get user's unique ID from session

//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error(error);
//       return res.status(500).send('Internal Server Error');
//     }

//     // Filter courses where SCORM path exists
//     const filteredResults = results.filter(course => {
//       const scormFolderPath = path.join(__dirname, course.scormPath);
//       return fs.existsSync(scormFolderPath);
//     });

//     // Fetch status for each course
//     const statusQueries = filteredResults.map(course => {
//       return new Promise((resolve, reject) => {
//         const statusQuery = `SELECT status1, status2, status3 FROM course_${course.courseID} WHERE uniqueID = ?`;
//         connection.query(statusQuery, [uniqueID], (err, statusResults) => {
//           if (err) {
//             console.error(err);
//             resolve({ courseID: course.courseID, status: 'No Attempt' }); // Default if error occurs
//           } else if (statusResults.length > 0) {
//             // Check status values and determine last attempt
//             const attempts = [];
//             for (let i = 1; i <= 3; i++) {
//               if (statusResults[0][`status${i}`]) {
//                 attempts.push(statusResults[0][`status${i}`]);
//               }
//             }
//             resolve({ courseID: course.courseID, status: attempts.length ? attempts.join(', ') : 'No Attempt' });
//           } else {
//             resolve({ courseID: course.courseID, status: 'No Attempt' });
//           }
//         });
//       });
//     });

//     Promise.all(statusQueries)
//       .then(statusResults => {
//         // Merge status with courses
//         const finalResults = filteredResults.map(course => {
//           const statusObj = statusResults.find(status => status.courseID === course.courseID);
//           return { ...course, status: statusObj ? statusObj.status : 'No Attempt' };
//         });

//         res.json(finalResults);
//       })
//       .catch(error => {
//         console.error(error);
//         res.status(500).send('Error fetching status data');
//       });
//   });
// });


// app.get('/getViewscormCourseList', (req, res) => {
//     // 🎯 CRITICAL CHANGE: Added 'courseTags' to the SELECT statement
//     const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID, courseTags FROM courses ORDER BY id DESC`;

//     // Ensure the user is logged in before proceeding (as you are relying on req.session.user)
//     if (!req.session || !req.session.user || !req.session.user.uniqueID) {
//         // If the user is not authenticated, return an empty array or an error
//         return res.status(401).json([]); 
//     }
//     const uniqueID = req.session.user.uniqueID; // Get user's unique ID from session

//     connection.query(query, (error, results) => {
//         if (error) {
//             console.error(error);
//             return res.status(500).send('Internal Server Error');
//         }

//         // Filter courses where SCORM path exists
//         const filteredResults = results.filter(course => {
//             // Note: __dirname might need adjustment depending on where this route is defined
//             const scormFolderPath = path.join(__dirname, course.scormPath);
//             return fs.existsSync(scormFolderPath);
//         });

//         // Fetch status for each course
//         const statusQueries = filteredResults.map(course => {
//             return new Promise((resolve, reject) => {
//                 const statusQuery = `SELECT status1, status2, status3 FROM course_${course.courseID} WHERE uniqueID = ?`;
//                 connection.query(statusQuery, [uniqueID], (err, statusResults) => {
//                     if (err) {
//                         console.error(`Error fetching status for course ${course.courseID}:`, err);
//                         resolve({ courseID: course.courseID, status: 'No Attempt' }); // Default if error occurs
//                     } else if (statusResults.length > 0) {
//                         // Check status values and determine last attempt
//                         const attempts = [];
//                         for (let i = 1; i <= 3; i++) {
//                             if (statusResults[0][`status${i}`]) {
//                                 attempts.push(statusResults[0][`status${i}`]);
//                             }
//                         }
//                         resolve({ courseID: course.courseID, status: attempts.length ? attempts.join(', ') : 'No Attempt' });
//                     } else {
//                         resolve({ courseID: course.courseID, status: 'No Attempt' });
//                     }
//                 });
//             });
//         });

//         Promise.all(statusQueries)
//             .then(statusResults => {
//                 // Merge status with courses
//                 const finalResults = filteredResults.map(course => {
//                     const statusObj = statusResults.find(status => status.courseID === course.courseID);
//                     return { ...course, status: statusObj ? statusObj.status : 'No Attempt' };
//                 });

//                 res.json(finalResults);
//             })
//             .catch(error => {
//                 console.error('Error in Promise.all for status queries:', error);
//                 res.status(500).send('Error fetching status data');
//             });
//     });
// });


app.get('/getViewscormCourseList', (req, res) => {

  // 1. Authentication Check
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    console.warn('Attempt to access course list without authentication. Returning 401.');
    return res.status(401).json([]);
  }
  const uniqueID = req.session.user.uniqueID;

  // Get ALL courses (we will filter this list below)
  // NOTE: 'courseTags' is no longer needed here, but keeping it won't hurt.
  const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID, level FROM courses ORDER BY id DESC`;

  connection.query(query, (error, allCourses) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error fetching courses.');
    }

    // 2. Process all courses for enrollment check, file existence, and status
    const courseChecks = allCourses.map(course => {
      return new Promise((resolve, reject) => {

        // First, check if the SCORM path exists (original functionality)
        const scormFolderPath = path.join(__dirname, course.scormPath);
        if (!fs.existsSync(scormFolderPath)) {
          console.warn(`SCORM path missing for course ${course.courseID}. Excluding.`);
          return resolve(null);
        }

        // 3. ENROLLMENT CHECK: Check if the user is present in the course's table
        const enrollmentCheckQuery = `SELECT uniqueID FROM course_${course.courseID} WHERE uniqueID = ? LIMIT 1`;

        connection.query(enrollmentCheckQuery, [uniqueID], (err, enrollmentResults) => {
          if (err) {
            // This error often means the course status table (e.g., course_123) does not exist yet.
            console.error(`DB Error (Table missing?) during enrollment check for course ${course.courseID}:`, err.message);
            return resolve(null); // Treat error as not enrolled
          }

          if (enrollmentResults.length === 0) {
            // 4. FILTERING LOGIC: User is NOT enrolled, resolve with null to exclude this course
            // 🎯 DEBUG LOGGING ADDED HERE:
            console.log(`User ${uniqueID} NOT enrolled in course ${course.courseID} (${course.courseName}). Excluding.`);
            return resolve(null);
          }

          // 🎯 DEBUG LOGGING ADDED HERE:
          console.log(`User ${uniqueID} IS enrolled in course ${course.courseID} (${course.courseName}). Proceeding to status check.`);

          // 5. STATUS FETCH (Existing Logic): User is ENROLLED, now fetch their status
          const statusQuery = `SELECT status1, status2, status3 FROM course_${course.courseID} WHERE uniqueID = ?`;
          connection.query(statusQuery, [uniqueID], (statusErr, statusResults) => {
            if (statusErr) {
              console.error(`Error fetching status for course ${course.courseID}:`, statusErr);
              // Resolve with course data, setting status to default if fetch failed
              return resolve({ ...course, status: 'Error Loading Status' });
            }

            let status = 'No Attempt';
            if (statusResults.length > 0) {
              const attempts = [];
              for (let i = 1; i <= 3; i++) {
                if (statusResults[0][`status${i}`]) {
                  attempts.push(statusResults[0][`status${i}`]);
                }
              }
              status = attempts.length ? attempts.join(', ') : 'No Attempt';
            }

            // Resolve with the fully processed course object
            resolve({ ...course, status });
          });
        });
      });
    });

    // 6. Wait for all checks and filters to complete
    Promise.all(courseChecks)
      .then(processedCourses => {
        // Filter out all the null results (non-enrolled or missing courses)
        const finalFilteredCourses = processedCourses.filter(course => course !== null);

        // 7. Send the final list of enrolled courses to the client
        res.json(finalFilteredCourses);
      })
      .catch(error => {
        console.error('Error during course enrollment/status processing:', error);
        res.status(500).send('Error processing course data');
      });
  });
});






// app.get('/getUserCourseTags', (req, res) => {
//     // 🎯 CRITICAL: Check for authentication using your existing session mechanism
//     if (!req.session || !req.session.user || !req.session.user.uniqueID) {
//         // Must return 401 or an empty object if unauthenticated
//         return res.status(401).json({ error: 'User not authenticated' });
//     }

//     const uniqueID = req.session.user.uniqueID;

//     // Query the users table for the courseTags column
//     const query = `SELECT courseTags FROM users WHERE uniqueID = ? LIMIT 1`;

//     connection.query(query, [uniqueID], (error, results) => {
//         if (error) {
//             console.error('Error fetching user course tags from DB:', error);
//             return res.status(500).json({ error: 'Internal Server Error fetching user tags' });
//         }

//         if (results.length > 0 && results[0].courseTags) {
//             // Send the raw comma-separated string back
//             res.json({ courseTags: results[0].courseTags });
//         } else {
//             // User found, but no tags defined (send empty string)
//             res.json({ courseTags: '' });
//         }
//     });
// });





// Route to delete a course from the database
app.delete('/deleteCourse', (req, res) => {
  const { courseID } = req.body;

  // Check if courseID is provided
  if (!courseID) {
    return res.status(400).send('Course ID is required');
  }

  // Perform deletion operation in the database
  const deleteCourseQuery = 'DELETE FROM courses WHERE courseID = ?';
  connection.query(deleteCourseQuery, [courseID], (error, results) => {
    if (error) {
      console.error('Error deleting course:', error);
      return res.status(500).send('Internal Server Error');
    }

    // Drop the associated course table dynamically
    const dropTableQuery = `DROP TABLE IF EXISTS course_${courseID}`;
    connection.query(dropTableQuery, (dropError) => {
      if (dropError) {
        console.error('Error dropping associated course table:', dropError);
        return res.status(500).send('Error deleting associated course table');
      }

      console.log(`Table course_${courseID} deleted successfully`);

      // Delete the associated SCORM package folder
      const scormFolderPath = path.join(__dirname, 'scorm', `course_${courseID}`);
      if (fs.existsSync(scormFolderPath)) {
        fs.rmdirSync(scormFolderPath, { recursive: true }); // Delete the folder recursively
        console.log('SCORM package deleted successfully');
      }

      console.log('Course deleted successfully');
      res.sendStatus(200);
    });
  });
});






// Get the course ID associated with the latest uploaded SCORM package
app.get('/getScormCourseID', (req, res) => {
  // First, execute the database query to get the latest course ID
  const query = `SELECT courseID FROM courses ORDER BY id DESC LIMIT 1`;
  connection.query(query, (error, results) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error');
    }

    if (results.length > 0) {
      const courseID = results[0].courseID;
      res.json({ courseID });
    } else {
      res.status(404).send('No course ID found');
    }
  });
});


// Define the GET endpoint for /getUsedCourseIDs
app.get('/getUsedCourseIDs', (req, res) => {
  // Query to fetch used course IDs from the database
  const query = 'SELECT DISTINCT courseID FROM courses'; // Assuming 'courses' is your table name

  // Execute the query
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching used course IDs:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Extract course IDs from the query results
    const usedCourseIDs = results.map(row => row.courseID);

    // Send the used course IDs as a JSON response
    res.json({ usedCourseIDs });
  });
});



// Employee login route
app.post('/employeelogin', (req, res) => {
  const { username, password } = req.body;
  connection.query('SELECT * FROM users WHERE uName = ? AND uPass = ?', [username, password], (error, results) => {
    if (error) {
      console.error('Error in database query:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length > 0) {
      // User found, login successful
      const user = results[0];
      req.session.user = { username: user.uName, uniqueID: user.uniqueID }; // Extract uniqueID from the query result
      const currentDate = new Date();

      // Update lastLoggedIn column
      connection.query('UPDATE users SET lastLoggedIn = ? WHERE uName = ?', [currentDate, username], (updateError) => {
        if (updateError) {
          console.error('Error updating lastLoggedIn:', updateError);
          return res.status(500).json({ success: false, message: 'Failed to update login time' });
        }
        console.log('Login time updated successfully');
        return res.json({ success: true });
      });
    } else {
      // No matching user found or incorrect password
      console.error('Invalid username or password');
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  });
});

// In index.js (or wherever your Express routes are defined)

app.post('/update-data', (req, res) => {
  const { uniqueID, LisenceIssue, Level } = req.body;

  console.log("Received data:", { uniqueID, LisenceIssue, Level });

  const query = `UPDATE users SET LisenceIssueDate = ?, Level = ? WHERE uniqueID = ?`;
  connection.query(query, [LisenceIssue, Level, uniqueID], (updateError, results) => {
    if (updateError) {
      console.error('Error updating database:', updateError);
      return res.status(500).json({ success: false, message: 'Failed to update database' });
    }
    console.log('Database updated successfully');
    return res.json({ success: true });
  });
});




// Admin login route
app.post('/adminlogin', (req, res) => {
  const { username, password } = req.body;
  connection.query('SELECT * FROM users WHERE uName = ? AND uPass = ?', [username, password], (error, results) => {
    if (error) {
      console.error('Error in database query:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length > 0) {
      // User found
      const userRole = results[0].uRole;
      if (userRole === 'Manager') {
        const user = results[0];
        req.session.user = { username: user.uName, uniqueID: user.uniqueID };
        const currentDate = new Date();

        // Update lastLoggedIn column
        connection.query('UPDATE users SET lastLoggedIn = ? WHERE uName = ?', [currentDate, username], (updateError) => {
          if (updateError) {
            console.error('Error updating lastLoggedIn:', updateError);
            return res.status(500).json({ success: false, message: 'Failed to update login time' });
          }
          console.log('Login time updated successfully');
          return res.json({ success: true, userRole });
        });
      } else {
        return res.status(403).json({ success: false, message: 'You are not authorized to access this page.' });
      }
    } else {
      console.error('Invalid username or password');
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
  });
});





// Route for serving userManagement.html
app.get('/userManagement', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'userManagement.html'));
});

// // Route for retrieving user data from the database
// app.get('/userData', (req, res) => {
//   // Query to retrieve user data from the database
//   const query = 'SELECT name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, uRole, currentDate,Contract FROM users'; // Adjust query based on your database schema
//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error('Error retrieving user data:', error);
//       return res.status(500).send('Internal Server Error');
//     }
//     // Sending user data as JSON response
//     res.json(results);
//   });
// });


// test route
app.get('/userData', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  const usersQuery = `
    SELECT uniqueID, name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, uRole, currentDate, Contract
    FROM users
    LIMIT ?, ?
  `;

  const countQuery = `SELECT COUNT(*) as total FROM users`;

  // Run first query
  connection.query(usersQuery, [offset, limit], (err, usersResult) => {
    if (err) {
      console.error('Error fetching users:', err);
      return res.status(500).json({ error: 'Error fetching users' });  // ✅ Return valid JSON error
    }

    // Run second query
    connection.query(countQuery, (err2, countResult) => {
      if (err2) {
        console.error('Error fetching total:', err2);
        return res.status(500).json({ error: 'Error counting users' }); // ✅ Return valid JSON error
      }

      const total = countResult[0].total;
      return res.json({ users: usersResult, total });  // ✅ Return proper data
    });
  });
});







// Route for serving gradesManagement.html
app.get('/gradesManagement', (req, res) => {
  // Fetch course names from the database
  const query = 'SELECT courseName FROM courses'; // Assuming you have a table named 'courses' with a column 'courseName'

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving course names:', error);
      return res.status(500).send('Internal Server Error');
    }

    // Extract course names from the database results
    const courseNames = results.map(row => row.courseName);

    // Render the 'gradesManagement.html' template and pass courseNames to it
    res.render('gradesManagement.html', { courseNames });
    console.log("Coursenames = " + courseNames);
  });
});


// Route for retrieving grades data from the database
app.get('/gradesData', (req, res) => {
  // Query to retrieve grades data from the database
  const query = 'SELECT * FROM users'; // Adjust query based on your database schema
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving grades data:', error);
      return res.status(500).send('Internal Server Error');
    }
    // Sending grades data as JSON response
    res.json(results);
  });
});


//Get data from Database of specific ID
app.get("/getCertificate", (req, res) => {
  const id = req.query.id;
  console.log("ID" + id);
  if (!id) {
    return res.json({ error: "No ID provided" });
  }

  const query = "SELECT * FROM users  WHERE uniqueID = ?";
  connection.query(query, [id], (err, result) => {
    if (err) {
      console.log(res);
      return res.json({ error: "Database error" });

    }
    if (result.length === 0) {
      console.log(res);
      return res.json({ error: "No record found" });
    }
    console.log(res);
    res.json(result[0]);
  });
});


//route for the certificate data fetching changing and the updating  4/10/2025
app.post('/update-license-issue', (req, res) => {
  // Note: LisenceIssueDate is the DB column name, LisenceIssue is the client variable name.
  const { uniqueID: rawUniqueID, LisenceIssue, Level, photo } = req.body;

  // CRITICAL FIX: Trim the uniqueID to prevent database lookup failures due to whitespace.
  const uniqueID = rawUniqueID.trim();

  if (!uniqueID || !LisenceIssue || !Level) {
    console.error('Missing fields for license update:', req.body);
    return res.status(400).json({ success: false, error: 'Missing uniqueID, license date, level, or photo filename.' });
  }

  console.log("Received data for update:", { uniqueID, LisenceIssue, Level, photo });

  // Ensure query updates the correct columns and includes the photo.
  const query = `UPDATE users SET LisenceIssueDate = ?, Level = ?, photo = ? WHERE uniqueID = ?`;

  connection.query(query, [LisenceIssue, Level, photo, uniqueID], (updateError, results) => {
    if (updateError) {
      console.error('Database error during update:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update database' });
    }

    if (results.affectedRows === 0) {
      console.warn(`Update failed: User with uniqueID ${uniqueID} not found. Affected rows: 0.`);
      return res.status(404).json({ success: false, error: 'User not found or no changes were required.' });
    }

    console.log(`Database updated successfully for user ${uniqueID}.`);
    return res.json({ success: true });
  });
});


// Add this endpoint to your server file (e.g., server.js or app.js)

app.get('/getUsersByDepartment', (req, res) => {
    const { department } = req.query;
    
    if (!department || department === 'all') {
        return res.json({ success: true, userIDs: [], department: 'all', courseCount: 0 });
    }

    // Step 1: Get all courses for the selected department
    const coursesQuery = 'SELECT courseID FROM courses WHERE department = ?';
    
    connection.query(coursesQuery, [department], (error, courses) => {
        if (error) {
            console.error('Error fetching courses:', error);
            return res.status(500).json({ 
                success: false, 
                message: 'Error fetching courses',
                error: error.message 
            });
        }
        
        if (courses.length === 0) {
            return res.json({ 
                success: true, 
                userIDs: [], 
                department: department,
                courseCount: 0 
            });
        }

        // Step 2: Collect all unique user IDs
        const userIDsSet = new Set();
        let processedCount = 0;
        
        courses.forEach((course, index) => {
            const tableName = `course_${course.courseID}`;
            const usersQuery = `SELECT DISTINCT uniqueID FROM ${tableName} WHERE uniqueID IS NOT NULL`;
            
            connection.query(usersQuery, (err, users) => {
                if (!err && users) {
                    users.forEach(user => {
                        if (user.uniqueID) {
                            userIDsSet.add(user.uniqueID);
                        }
                    });
                }
                
                processedCount++;
                
                // When all courses are processed, send response
                if (processedCount === courses.length) {
                    const userIDs = Array.from(userIDsSet);
                    res.json({ 
                        success: true, 
                        userIDs: userIDs,
                        department: department,
                        courseCount: courses.length
                    });
                }
            });
        });
    });
});


// Route to fetch user grades based on employeeID old 26-07-2025
/*app.get('/getUserGrades', (req, res) => {
  const employeeID = req.query.employeeID;
  const query = 'SELECT * FROM users WHERE employeeID = ?';
  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Error fetching user data:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Extract user details from the query results
    const userDetails = {
      // name: results[0].name,
      // uName: results[0].uName
      employeeID: results[0].employeeID, // Assuming this is the field name in your database
      name: results[0].name
      // Add more user details if needed
    };

    // Extract grades from the query results
    const grades = [];
    // Assuming uCourse1, uCourse2, ... are columns in the users table
    for (let i = 1; i <= 50; i++) {
      const courseName = results[0][`uCourse${i}`] || 'N/A';
      const posttest = results[0][`course${i}Posttest`] || 'N/A';
      grades.push({ courseName, posttest });
    }

    res.json({ userDetails, grades });
  });
});*/


// Route to fetch user grades based on employeeID new 26-07-2025

app.get('/getUserGrades', (req, res) => {
  const employeeID = req.query.employeeID;
  const query = 'SELECT * FROM users WHERE employeeID = ?';
  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Error fetching user data:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = results[0];
    const userDetails = {
      employeeID: user.employeeID,
      name: user.name
    };

    const grades = [];

    for (let i = 1; i <= 50; i++) {
      const courseName = user[`uCourse${i}`] || 'N/A';
      const posttest = user[`course${i}Posttest`] || 'N/A';
      const attendanceDate = user[`course${i}TrainDate`] || 'N/A';

      grades.push({ courseName, posttest, attendanceDate });
    }

    res.json({ userDetails, grades });
  });
});





// Route to fetch user grades and attempts data based on employeeID
/*app.get('/getUserGrades', (req, res) => {
  const employeeID = req.query.employeeID;

  // Query to get user details from the users table
  const userQuery = 'SELECT * FROM users WHERE employeeID = ?';
  connection.query(userQuery, [employeeID], (userError, userResults) => {
    if (userError) {
      console.error('Error fetching user data:', userError);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (userResults.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Extract user details
    const userDetails = {
      employeeID: userResults[0].employeeID,
      name: userResults[0].name,
    };

    // Extract grades from the user results
    const grades = [];
    for (let i = 1; i <= 15; i++) {
      const courseName = userResults[0][`uCourse${i}`] || 'N/A';
      const posttest = userResults[0][`course${i}Posttest`] || 'N/A';
    }

    // Query to get attempts data from course_${courseID} table
    const attemptsQuery = `SELECT * FROM course_${courseID} WHERE employeeID = ?`;
    connection.query(attemptsQuery, [employeeID], (attemptsError, attemptsResults) => {
      if (attemptsError) {
        console.error('Error fetching attempts data:', attemptsError);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
      }

      // Prepare the response with user details, grades, and attempts
      res.json({ userDetails, grades, attempts: attemptsResults });
    });
  });
});*/


// Route to fetch user attempt data based on courseID and attemptNumber
// app.get('/getUserAttempts', (req, res) => {
//   const courseID = req.query.courseID;
//   const attemptNumber = req.query.attemptNumber;
//   const employeeID = req.query.employeeID; // Pass this from the front-end if needed
//   if (!courseID || !attemptNumber) {
//     return res.status(400).json({ success: false, message: 'Course ID and attempt number are required.' });
//   }

//   /*const query = `SELECT noOfAttempts, 
//                         course_${courseID}_Posttest${attemptNumber} AS posttest, 
//                         score${attemptNumber} AS score, 
//                         status${attemptNumber} AS status, 
//                         duration${attemptNumber} AS duration 
//                  FROM course_${courseID} 
//                  WHERE employeeID = ?`;*/
//   /*const query = `
//   SELECT 
//       noOfAttempts, course_${courseID}_Posttest${attemptNumber},
//       score${attemptNumber}, status${attemptNumber}, duration${attemptNumber}
//   FROM course_${courseID}
//   WHERE employeeID = ?
// `;*/
//   const query = `
//   SELECT 
//       noOfAttempts,  
//       course_${courseID}_Posttest${attemptNumber} AS posttest,
//       score${attemptNumber} AS score, 
//       status${attemptNumber} AS status, 
//       duration${attemptNumber} AS duration,
//       date${attemptNumber} AS date
//   FROM course_${courseID}
//   WHERE employeeID = ?
// `;


//   connection.query(query, [employeeID], (error, results) => {
//     if (error) {
//       console.error('Error fetching attempt data:', error);
//       console.error('courseID fail: ', courseID);
//       console.error('attemptNumber fail: ', attemptNumber);
//       console.error('employeeID fail: ', employeeID);
//       return res.status(500).json({ success: false, message: 'Internal Server Error' });
//     }
//     if (results.length === 0) {
//       console.error('courseID fail 2: ', courseID);
//       console.error('attemptNumber fail 2: ', attemptNumber);
//       console.error('employeeID fail 2: ', employeeID);
//       return res.status(404).json({ success: false, message: 'No data found for this attempt.' });
//     }
//     console.error('courseID Pass 2: ', courseID);
//     console.error('attemptNumber Pass 2: ', attemptNumber);
//     console.error('results Pass 2: ', results);

//     const attemptDetails_noOfAttempt = results[0].noOfAttempts;
//     const attemptDetails_posttest = results[0].posttest;
//     const attemptDetails_score = results[0].score;
//     const attemptDetails_status = results[0].status;
//     const attemptDetails_duration = results[0].duration;
//     const attemptsDetails_date=results[0].date;

//     console.error('results Pass 3: ', results[0].noOfAttempts);

//     res.json({ success: true, attemptData: results[0], attemptDetails_noOfAttempt: attemptDetails_noOfAttempt, attemptDetails_posttest: attemptDetails_posttest, attemptDetails_score: attemptDetails_score, attemptDetails_status: attemptDetails_status, attemptDetails_duration: attemptDetails_duration ,attemptsDetails_date: attemptsDetails_date});
//   });
// });





app.get('/getUserAttempts', (req, res) => {
  const { courseID, attemptNumber, employeeID } = req.query; // Destructure for cleaner access

  // Basic validation for required parameters
  if (!courseID || !attemptNumber || !employeeID) {
    return res.status(400).json({
      success: false,
      message: 'Course ID, attempt number, and employee ID are required.'
    });
  }

  // Construct the table name and column names dynamically
  const tableName = `course_${courseID}`;
  const posttestCol = `course_${courseID}_Posttest${attemptNumber}`;
  const scoreCol = `score${attemptNumber}`;
  const statusCol = `status${attemptNumber}`;
  const durationCol = `duration${attemptNumber}`;
  const dateCol = `date${attemptNumber}`;

  // Construct the SQL query using backticks for template literals
  // This helps in dynamic column naming
  const query = `
    SELECT
      noOfAttempts,
      ${posttestCol} AS posttest,
      ${scoreCol} AS score,
      ${statusCol} AS status,
      ${durationCol} AS duration,
      ${dateCol} AS date
    FROM ${tableName}
    WHERE employeeID = ?;
  `;

  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Database query error:', error);
      // Log specific details for debugging
      console.error(`Query: ${query}`);
      console.error(`Parameters: [${employeeID}]`);
      console.error(`Error details: courseID=${courseID}, attemptNumber=${attemptNumber}, employeeID=${employeeID}`);

      // Check for common SQL errors
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return res.status(500).json({
          success: false,
          message: `Error: Table '${tableName}' does not exist. Please check your database schema.`,
          errorCode: error.code
        });
      } else if (error.code === 'ER_BAD_FIELD_ERROR') {
        return res.status(500).json({
          success: false,
          message: `Error: One or more columns (e.g., ${posttestCol}, ${scoreCol}, ${statusCol}, ${durationCol}, ${dateCol}) do not exist in table '${tableName}'. Please check your database schema.`,
          errorCode: error.code
        });
      }
      return res.status(500).json({ success: false, message: 'Internal Server Error during database query.' });
    }

    if (results.length === 0) {
      // This is the case you are hitting: no rows found for the given employeeID in the specified table.
      console.warn(`No data found for employeeID: ${employeeID} in table: ${tableName} for attempt: ${attemptNumber}`);
      return res.status(404).json({
        success: false,
        message: `No attempt data found for employee ID ${employeeID} in course ${courseID} for attempt number ${attemptNumber}.`
      });
    }

    // If data is found, send the first result directly.
    // The aliases in the SQL query (AS posttest, AS score, etc.) make the result object cleaner.
    const attemptData = results[0];

    console.log('Successfully fetched attempt data:', attemptData);

    res.json({
      success: true,
      attemptData: attemptData
    });
  });
});





/*
// Route to delete a user from the database
app.delete('/deleteUser', (req, res) => {
  const { employeeID } = req.body; // Assuming you are passing employeeID from the client-side
  // Perform deletion operation in the database based on employeeID
  const query = 'DELETE FROM users WHERE employeeID = ?';
  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Error deleting user:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User deleted successfully');
    res.sendStatus(200);
  });
});*/

//Function for delete users in user Management 23-07-25
app.delete('/deleteUser', (req, res) => {
  const { uniqueID } = req.body; // Assuming you are passing uniqueID from the client-side
  // Perform deletion operation in the database based on uniqueID
  const query = 'DELETE FROM users WHERE uniqueID = ?';
  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error deleting user:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User deleted successfully');
    res.sendStatus(200);
  });
});







// Add a route for logging out
app.get('/logout', (req, res) => {
  // Clear the user's session
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Internal Server Error');
    }
    // Redirect the user to the login page after logout
    res.redirect('/home.html'); // Update the path to your login page
  });
});



// Update user's SCORM data old 34-07-2025
/*app.post('/updateUserSCORMData', (req, res) => {

  const trainDate = currentDate+currentTime;
  const { posttestScore, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  const trainDateColumn = `course${courseID}TrainDate`;

  console.log("uniqueID is: " + uniqueID);

  // Update the user's SCORM data in the database
  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ?, ${trainDateColumn} =? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User SCORM data updated successfully');
    console.log('Result ', posttestScore, courseName,trainDate, uniqueID);
    res.sendStatus(200);
  });
});*/





/*app.post('/updateUserSCORMData', (req, res) => {
  const { posttestScore, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // Format current date and time in 'YYYY-MM-DD HH:mm:ss' (local time)
  const now = new Date();
  const trainDate = now.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', // or your preferred time zone
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(',', '');

  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  const trainDateColumn = `course${courseID}TrainDate`;

  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ?, ${trainDateColumn} = ? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Updated with time:', trainDate);
    res.sendStatus(200);
  });
});*/





// At the top of your file (outside the route handler)
function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}


// Commented by yash on 27-09-2025 3.05pm
// app.post('/updateUserSCORMData', (req, res) => {
//   const { posttestScore, courseID, courseName } = req.body;

//   if (!req.session || !req.session.user || !req.session.user.uniqueID) {
//     return res.status(401).send('User session not found');
//   }

//   const uniqueID = req.session.user.uniqueID;
//   const trainDate = getFormattedDateTimeIST();

//   const posttestColumn = `course${courseID}Posttest`;
//   const courseNameColumn = `uCourse${courseID}`;
//   const trainDateColumn = `course${courseID}TrainDate`;

//   const query = `
//     UPDATE users 
//     SET ${posttestColumn} = ?, 
//         ${courseNameColumn} = ?, 
//         ${trainDateColumn} = ? 
//     WHERE uniqueID = ?
//   `;

//   console.log('Executing update with values:', {
//     posttestScore,
//     courseName,
//     trainDate,
//     uniqueID
//   });

//   connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
//     if (error) {
//       console.error('Error updating user SCORM data:', error);
//       return res.status(500).send('Internal Server Error');
//     }

//     if (results.affectedRows === 0) {
//       console.warn('Update query ran but no rows were affected');
//     } else {
//       console.log('Successfully updated with time:', trainDate);
//     }

//     res.sendStatus(200);
//   });
// });

// helpers
function safeCourseID(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("bad courseID");
  return n;
}
function colUsersPosttest(courseID) { return `course${courseID}Posttest`; }
function colUsersCourseName(courseID) { return `uCourse${courseID}`; }
function colUsersTrainDate(courseID) { return `course${courseID}TrainDate`; }
function colCoursePosttest(courseID, attempt) { return `course_${courseID}_Posttest${attempt}`; }



app.post('/updateUserSCORMData', (req, res) => {
  try {
    if (!req.session?.user?.uniqueID) return res.status(401).send('User session not found');
    const { posttestScore = "", courseID, courseName = "" } = req.body;
    const cid = safeCourseID(courseID);
    const uniqueID = req.session.user.uniqueID;
    const trainDate = getFormattedDateTimeIST();

    const query = `
      UPDATE users
      SET ${colUsersPosttest(cid)} = ?,
          ${colUsersCourseName(cid)} = ?,
          ${colUsersTrainDate(cid)} = ?
      WHERE uniqueID = ?
    `;
    connection.query(query, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
      if (error) { console.error(error); return res.status(500).send('Internal Server Error'); }
      res.sendStatus(200);
    });
  } catch (e) {
    console.error(e);
    res.status(400).send('Bad Request');
  }
});



/*function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

app.post('/updateUserSCORMData', (req, res) => {
  const { posttestScore, courseID, courseName } = req.body;

  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).send('User session not found');
  }

  const uniqueID = req.session.user.uniqueID;
  const trainDate = getFormattedDateTimeIST();

  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  const trainDateColumn = `course${courseID}TrainDate`;

  // Step 1: Update users table with overall course score, name, date
  const updateUsersQuery = `
    UPDATE users 
    SET ${posttestColumn} = ?, 
        ${courseNameColumn} = ?, 
        ${trainDateColumn} = ? 
    WHERE uniqueID = ?
  `;

  connection.query(updateUsersQuery, [posttestScore, courseName, trainDate, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating users table:', error);
      return res.status(500).send('Internal Server Error');
    }

    // ✅ Step 2: Now fetch attempt number (noOfAttempts) for this user from course table
    const fetchAttemptsQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE employeeID = ?`;
    connection.query(fetchAttemptsQuery, [uniqueID], (err2, result2) => {
      if (err2 || result2.length === 0) {
        console.error('Error fetching attempt number:', err2 || 'No data found');
        return res.status(500).send('Failed to get attempt number');
      }

      const attemptNumber = result2[0].noOfAttempts;
      const dateColumn = `date${attemptNumber}`;

      // ✅ Step 3: Update course_X.dateX with current timestamp
      const updateCourseDateQuery = `UPDATE course_${courseID} SET ${dateColumn} = ? WHERE employeeID = ?`;
      connection.query(updateCourseDateQuery, [trainDate, uniqueID], (err3, result3) => {
        if (err3) {
          console.error('Error updating course table date column:', err3);
          return res.status(500).send('Failed to update course attempt date');
        }

        console.log(`✅ Updated date for course_${courseID}.${dateColumn} = ${trainDate}`);
        return res.sendStatus(200); // All done!
      });
    });
  });
});*/






// Update user's SCORM data
app.post('/updateUserExcelData', (req, res) => {

  const { localPosttest, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  console.log("uniqueID is: " + uniqueID);

  // Update the user's SCORM data in the database
  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ? WHERE uniqueID = ?`;
  connection.query(query, [localPosttest, courseName, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User Excel data updated successfully');
    console.log('Result ', localPosttest, courseName, uniqueID);
    res.sendStatus(200);
  });
});



// Update user's SCORM data
/*app.post('/updateUserSCORMDataInCourseTable', (req, res) => {

  const { posttestScore, Score, Status, duration, courseID } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course_${courseID}_Posttest1`;
  console.log("uniqueID is: " + uniqueID);

  // Update the user's SCORM data in the database
  const query = `UPDATE course_${courseID} SET ${posttestColumn} = ?, score1 = ?, status1 = ?, duration1 = ? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, Score, Status, duration, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User SCORM data updated successfully');
    res.sendStatus(200);
  });
});*/

//extra work 25-07-25

function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}


// Update user's SCORM data
/*app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
  const { posttestScore, Score, Status, duration, date,courseID } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // Query to get the current attempt count for the user
  const getAttemptQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE uniqueID = ?`;

  connection.query(getAttemptQuery, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching attempt count:', error);
      return res.status(500).send('Internal Server Error');
    }

    let attempt = 1; // Default to 1 if no record exists
    if (results.length > 0) {
      attempt = results[0].noOfAttempts;
    }

    // Construct column names dynamically based on the current attempt
    const posttestColumn = `course_${courseID}_Posttest${attempt}`;
    const scoreColumn = `score${attempt}`;
    const statusColumn = `status${attempt}`;
    const durationColumn = `duration${attempt}`;
    const dateColumn=`date${attempt}`;

    // Update the user's SCORM data in the database
    const updateQuery = `
      UPDATE course_${courseID}
      SET ${posttestColumn} = ?, ${scoreColumn} = ?, ${statusColumn} = ?, ${durationColumn} = ?,${dateColumn}=? noOfAttempts = ?
      WHERE uniqueID = ?
    `;

    connection.query(updateQuery, [posttestScore, Score, Status, duration,date, attempt, uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating user SCORM data:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('User SCORM data updated successfully for attempt', attempt);
      res.sendStatus(200);
    });
  });
});*/


// Commented on 27-09-2025 3.05pm
// app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
//   const { posttestScore, Score, Status, duration, courseID } = req.body;
//   const uniqueID = req.session.user.uniqueID;

//   const getAttemptQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE uniqueID = ?`;

//   connection.query(getAttemptQuery, [uniqueID], (error, results) => {
//     if (error) {
//       console.error('Error fetching attempt count:', error);
//       return res.status(500).send('Internal Server Error');
//     }

//     let attempt = 1;
//     if (results.length > 0) {
//       attempt = results[0].noOfAttempts;
//     }

//     const posttestColumn = `course_${courseID}_Posttest${attempt}`;
//     const scoreColumn = `score${attempt}`;
//     const statusColumn = `status${attempt}`;
//     const durationColumn = `duration${attempt}`;
//     const dateColumn = `date${attempt}`;
//     const date = getFormattedDateTimeIST();  // ✅ Add date value here

//     const updateQuery = `
//       UPDATE course_${courseID}
//       SET ${posttestColumn} = ?,
//           ${scoreColumn} = ?,
//           ${statusColumn} = ?,
//           ${durationColumn} = ?,
//           ${dateColumn} = ?,
//           noOfAttempts = ?
//       WHERE uniqueID = ?
//     `;

//     const values = [posttestScore, Score, Status, duration, date, attempt, uniqueID];

//     connection.query(updateQuery, values, (error, results) => {
//       if (error) {
//         console.error('Error updating user SCORM data:', error);
//         return res.status(500).send('Internal Server Error');
//       }

//       console.log(`✅ SCORM data updated for attempt ${attempt} at ${date}`);
//       res.sendStatus(200);
//     });
//   });
// });

app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
  try {
    if (!req.session?.user?.uniqueID) return res.status(401).send('User session not found');

    const { posttestScore = "", Score = "", Status = "", duration = "", courseID } = req.body;
    const cid = safeCourseID(courseID);
    const uniqueID = req.session.user.uniqueID;

    const getAttemptQuery = `SELECT noOfAttempts FROM course_${cid} WHERE uniqueID = ?`;
    connection.query(getAttemptQuery, [uniqueID], (error, results) => {
      if (error) { console.error(error); return res.status(500).send('Internal Server Error'); }
      // if row missing, you may want to INSERT a seed row here
      const attempt = results?.[0]?.noOfAttempts || 1;
      const date = getFormattedDateTimeIST();

      const updateQuery = `
        UPDATE course_${cid}
        SET ${colCoursePosttest(cid, attempt)} = ?,
            score${attempt} = ?,
            status${attempt} = ?,
            duration${attempt} = ?,
            date${attempt} = ?,
            noOfAttempts = ?
        WHERE uniqueID = ?
      `;
      connection.query(updateQuery, [posttestScore, Score, Status, duration, date, attempt, uniqueID], (error2) => {
        if (error2) { console.error(error2); return res.status(500).send('Internal Server Error'); }
        res.sendStatus(200);
      });
    });
  } catch (e) {
    console.error(e);
    res.status(400).send('Bad Request');
  }
});




// Update user's SCORM data
app.post('/updateUserEXCELDataInCourseTable', (req, res) => {
  const { localPosttest, localScore, localStatus, localduration, localDate, courseID } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // Query to get the current attempt count for the user
  const getAttemptQuery = `SELECT noOfAttempts FROM course_${courseID} WHERE uniqueID = ?`;

  connection.query(getAttemptQuery, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching attempt count:', error);
      return res.status(500).send('Internal Server Error');
    }

    let attempt = 1; // Default to 1 if no record exists
    if (results.length > 0) {
      attempt = results[0].noOfAttempts;
    }

    // Construct column names dynamically based on the current attempt
    const posttestColumn = `course_${courseID}_Posttest${attempt}`;
    const scoreColumn = `score${attempt}`;
    const statusColumn = `status${attempt}`;
    const durationColumn = `duration${attempt}`;
    const dateColumn = `date${attempt}`;

    // Update the user's SCORM data in the database
    const updateQuery = `
      UPDATE course_${courseID}
      SET ${posttestColumn} = ?, ${scoreColumn} = ?, ${statusColumn} = ?, ${durationColumn} = ?, ${dateColumn}=? , noOfAttempts = ?
      WHERE uniqueID = ?
    `;

    connection.query(updateQuery, [localPosttest, localScore, localStatus, localduration, localDate, attempt, uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating user SCORM data:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('User SCORM data updated successfully for attempt', attempt);
      res.sendStatus(200);
    });
  });
});






// Update user's attempt count
app.get('/updateAttempt', (req, res) => {
  const courseID = req.query.courseID;
  const uniqueID = req.session.user.uniqueID;

  const query = `UPDATE course_${courseID} SET noOfAttempts = noOfAttempts + 1 WHERE uniqueID = ?`;
  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating attempt count:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Attempt count updated successfully');
    console.log('Course ID from index fn: ' + courseID);
    res.json({ success: true });
  });



  // connection.query(query, [uniqueID], (selectError, results) => {
  //   if (selectError) {
  //     console.error('Error retrieving current number of attempts:', selectError);
  //     return res.status(500).send('Internal Server Error');
  //   }

  //   let attempts = results[0][courseTable] || 0;
  //   attempts += 1;

  //   // Update the user's SCORM data in the database
  //   const query = `UPDATE ${courseTable} SET noOfAttempts = noOfAttempts + 1 WHERE uniqueID = ?`;
  //   connection.query(query, [uniqueID], (error, results) => {
  //     if (error) {
  //       console.error('Error updating attempt count:', error);
  //       return res.status(500).send('Internal Server Error');
  //     }
  //     console.log('Attempt count updated successfully');
  //     console.log('Course ID: ' + courseID);
  //     res.json({ success: true });
  //   });
  // });
});






// Middleware to check if the user is authenticated
function requireAuth(req, res, next, username) {
  if (req.session && req.session.user && req.session.user.username === username) {
    // User is authenticated, proceed to the next middleware/route handler
    next();
  } else {
    // User is not authenticated, redirect to the login page
    res.redirect('/home.html'); // Redirect to the appropriate login page
  }
}

// Apply requireAuth middleware to routes that require authentication
app.use(['/addUser.html', '/courseManagement.html', '/lmshomepage.html', '/scormview.html', '/viewscorm.html'], requireAuth);

// Routes for pages where users can go without logging in
app.get(['/home.html', '/userlogin.html', '/adminlogin.html', '/managerlogin.html', '/employeelogin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', req.path));
});

// Employee login route
app.post('/employeelogin', (req, res) => {
  // Your existing login logic
});






// Course Details Page
// Route to get course details by ID
app.get('/course/:courseID', (req, res) => {
  const courseID = req.params.courseID;

  const query = `SELECT courseName, courseDescription, courseDate, level FROM courses WHERE courseID = ?`;
  connection.query(query, [courseID], (error, results) => {
    if (error) {
      console.error('Error fetching course details:', error);
      return res.status(500).send('Internal Server Error');
    }

    if (results.length > 0) {
      res.json(results[0]);
    } else {
      res.status(404).send('Course not found');
    }
  });
});


// Route for retrieving user data from the database
app.get('/courseDetailsUserData', (req, res) => {
  const courseID = req.query.courseID; // Get courseID from query parameter
  
  if (!courseID) {
    return res.status(400).json({ error: 'Course ID is required' });
  }

  // Dynamically construct the column name for the training date
  const trainDateColumn = `course${courseID}TrainDate`;
  
  // Query to retrieve user data including the training date for the specific course
  const query = `SELECT uniqueID, name, employeeID, uName, dateOfJoining, department, currentDate, ${trainDateColumn} as trainingDate FROM users`;
  
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving user data:', error);
      return res.status(500).send('Internal Server Error');
    }
    
    // Process results to add expiration status
    const processedResults = results.map(user => {
      let isExpired = false;
      let daysUntilExpiry = null;
      
      if (user.trainingDate) {
        const trainDate = new Date(user.trainingDate);
        const currentDate = new Date();
        
        // Calculate 3 months from training date
        const expiryDate = new Date(trainDate);
        expiryDate.setMonth(expiryDate.getMonth() + 3);
        
        // Check if training has expired (3 months or more have passed)
        isExpired = currentDate >= expiryDate;
        
        // Calculate days until expiry
        const timeDiff = expiryDate - currentDate;
        daysUntilExpiry = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
      }
      
      return {
        ...user,
        isExpired,
        daysUntilExpiry
      };
    });
    
    res.json(processedResults);
  });
});





app.post('/enrollUsersToCourse/:courseID', (req, res) => {
  const courseID = req.params.courseID;
  const selectedUsers = req.body.users;

  if (selectedUsers && selectedUsers.length > 0) {
    // Get unique IDs of selected users
    const userUniqueIDs = selectedUsers.map(user => user.uniqueID);

    // Check which users are already enrolled in the course
    const checkQuery = `SELECT uniqueID FROM course_${courseID} WHERE uniqueID IN (?)`;
    connection.query(checkQuery, [userUniqueIDs], (checkError, results) => {
      if (checkError) {
        console.error('Error checking existing users:', checkError);
        return res.status(500).send('Error checking existing users');
      }

      // Get the IDs of already enrolled users
      const enrolledUserIDs = results.map(row => row.uniqueID);

      // Filter out users already enrolled
      const newUsers = selectedUsers.filter(user => !enrolledUserIDs.includes(user.uniqueID));

      if (newUsers.length > 0) {
        const values = newUsers.map(user => [user.uniqueID, user.employeeID, user.name]);
        const insertQuery = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;

        connection.query(insertQuery, [values], (insertError, insertResults) => {
          if (insertError) {
            console.error('Error enrolling new users:', insertError);
            return res.status(500).send('Error enrolling new users');
          }

          const message = enrolledUserIDs.length > 0
            //? `Some users were already enrolled and skipped: ${enrolledUserIDs.join(', ')}`
            ? `Some users were already enrolled.`
            : 'Users enrolled successfully';
          res.json({ message, results: insertResults });
        });
      } else {
        res.json({ message: 'All selected users are already enrolled.' });
      }
    });
  } else {
    res.status(400).send('No users selected for enrollment');
  }
});
// Get enrolled users for a specific course
app.get('/getEnrolledUsers/:courseID', (req, res) => {
    const courseID = req.params.courseID;
    
    const query = `SELECT uniqueID, employeeID, name FROM course_${courseID}`;
    
    connection.query(query, (error, results) => {
        if (error) {
            console.error('Error fetching enrolled users:', error);
            return res.status(500).json({ 
                success: false, 
                message: 'Error fetching enrolled users' 
            });
        }
        
        res.json({ 
            success: true, 
            enrolledUsers: results 
        });
    });
});

// Unenroll users from course
app.post('/unenrollUsersFromCourse/:courseID', (req, res) => {
    const courseID = req.params.courseID;
    const selectedUsers = req.body.users;

    if (selectedUsers && selectedUsers.length > 0) {
        const userUniqueIDs = selectedUsers.map(user => user.uniqueID);

        // Delete users from the course table
        const deleteQuery = `DELETE FROM course_${courseID} WHERE uniqueID IN (?)`;
        
        connection.query(deleteQuery, [userUniqueIDs], (deleteError, results) => {
            if (deleteError) {
                console.error('Error unenrolling users:', deleteError);
                return res.status(500).json({ 
                    success: false,
                    message: 'Error unenrolling users' 
                });
            }

            const unenrolledCount = results.affectedRows;
            
            res.json({ 
                success: true,
                message: `${unenrolledCount} user(s) unenrolled successfully.`,
                unenrolledCount: unenrolledCount
            });
        });
    } else {
        res.status(400).json({ 
            success: false,
            message: 'No users selected for unenrollment' 
        });
    }
});









// Add a route to get user's grades
app.get('/getMyGrades', (req, res) => {
  const uniqueID = req.session.user.uniqueID;
  const query = `SELECT * FROM users WHERE uniqueID = ?`;
  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching user data:', error);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userDetails = {
      name: results[0].name,
      uName: results[0].uName,
      uniqueID: results[0].uniqueID
    };

    const grades = [];
    // Assuming uCourse1, uCourse2, ... are columns in the users table
    for (let i = 1; i <= 100; i++) {
      const courseName = results[0][`uCourse${i}`] || 'N/A';
      const posttest = results[0][`course${i}Posttest`] || 'N/A';
      grades.push({ courseName, posttest });
    }

    res.json({ userDetails, grades });
  });
});


// Route for serving myProfile.html and fetching user details
app.get('/myProfile', (req, res) => {
  // Extract the username of the logged-in user from the session
  const username = req.session.user.username;

  // Query to retrieve user data for the logged-in user only
  const query = 'SELECT name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, dateOfJoining, department, uRole, currentDate, photo FROM users WHERE uName = ?';

  connection.query(query, [username], (error, results) => {
    if (error) {
      console.error('Error retrieving user data:', error);
      return res.status(500).send('Internal Server Error');
    }
    // Sending user data as JSON response
    res.json(results);
  });
});




// Route to handle bulk user upload
// app.post('/upload-bulk-users', upload.single('bulkUsersFile'), (req, res) => {
//   if (!req.file) {
//     return res.status(400).send('No file uploaded.');
//   }
//   // const uniqueID =uuidv4();
//   const workbook = xlsx.readFile(req.file.path);
//   const sheetName = workbook.SheetNames[0];
//   const sheet = workbook.Sheets[sheetName];
//   const usersData = xlsx.utils.sheet_to_json(sheet);

//   usersData.forEach(user => {
//     // Insert each user into the database
//     let uniqueID = uuidv4();
//     const query = `INSERT INTO users (name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, currentDate,uniqueID,Qualification,Contract) VALUES (?,?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)`;
//     connection.query(query, [
//       user.name, user.emailID, user.employeeID, user.uName,
//       user.uPass, user.dateOfJoining, user.dateOfBirth,
//       user.address, user.mobileNo, user.department, user.uRole, user.currentDate, uniqueID, user.Qualification, user.Contract
//     ], (error, results) => {
//       if (error) {
//         console.error('Error inserting user:', error);
//       } else {
//         console.log('User inserted successfully:', user.name);
//       }
//     });
//   });
//   console.log("Bluk users uploaded successfully");
//   //res.send('Bulk users uploaded successfully.');
// });



// -------------------- BACKEND --------------------
app.post('/upload-bulk-users', upload.single('bulkUsersFile'), (req, res) => {
  if (!req.file) return res.status(400).send({ error: 'No file uploaded.' });

  const workbook = xlsx.readFile(req.file.path);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const usersData = xlsx.utils.sheet_to_json(sheet);

  // ---- NEW: Check DB duplicates ----
  const namesInExcel = usersData.map(u => u.name);
  const usernamesInExcel = usersData.map(u => u.uName);

  const query = `SELECT name, uName FROM users WHERE name IN (?) OR uName IN (?)`;
  connection.query(query, [namesInExcel, usernamesInExcel], (err, results) => {
    if (err) return res.status(500).send({ error: 'DB error' });

    // Mark duplicates
    usersData.forEach(u => {
      const nameDup = results.some(r => r.name === u.name);
      const unameDup = results.some(r => r.uName === u.uName);

      if (nameDup && unameDup) u.duplicateType = 'both';
      else if (nameDup) u.duplicateType = 'db';
      else if (unameDup) u.duplicateType = 'db';
      else u.duplicateType = 'none';
    });

    // Check duplicates inside Excel itself
    const nameCount = {}, unameCount = {};
    usersData.forEach(u => {
      if (u.name) nameCount[u.name] = (nameCount[u.name] || 0) + 1;
      if (u.uName) unameCount[u.uName] = (unameCount[u.uName] || 0) + 1;
    });
    usersData.forEach(u => {
      if ((nameCount[u.name] > 1 || unameCount[u.uName] > 1) && u.duplicateType === 'none') {
        u.duplicateType = 'excel';
      }
    });

    res.json({ users: usersData });
  });
});



app.post('/confirm-bulk-users', express.json(), (req, res) => {
  const users = req.body.users.filter(u => u.duplicateType === 'none'); // only non-duplicates

  if (!users.length) return res.send('No valid users to upload.');

  users.forEach(user => {
    const uniqueID = uuidv4();
    const query = `
      INSERT INTO users (name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, currentDate, uniqueID, Qualification, Contract)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;
    connection.query(query, [
      user.name, user.emailID, user.employeeID, user.uName,
      user.uPass, user.dateOfJoining, user.dateOfBirth,
      user.address, user.mobileNo, user.department,
      user.uRole, user.currentDate, uniqueID, user.Qualification, user.Contract
    ], err => {
      if (err) console.error('Insert error:', err);
    });
  });

  res.send('Users uploaded successfully.');
});


// // Route to handle saving changes
/*app.post('/saveChanges', (req, res) => {
  const updatedData = req.body;

  // Loop through updated data and update corresponding records in the database
  updatedData.forEach(data => {
    // Construct the column name based on the courseID
    const mysqlColumnName  = `uCourse${data.courseID}`;
    // Assuming you have a function to update the database
    updateDatabase(data.employeeID, data.columnName, mysqlColumnName , data.newValue);
  });

  // Send response
  res.sendStatus(200);
});*/







//this router for the save updating grades from the gradesmanagement 24-04-2025  with employeeID
/*app.post('/saveChanges', async (req, res) => {
    const updates = req.body.updatedData;

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'No data received' });
    }

    const connectionPromise = connection.promise();
    const updateTasks = [];

    try {
        for (const entry of updates) {
            const { employeeID, columnName, newValue, courseName } = entry;

            if (!employeeID || !columnName) continue;

            // Update the Posttest score (or other field)
            const query = `UPDATE users SET \`${columnName}\` = ? WHERE employeeID = ?`;
            updateTasks.push(connectionPromise.query(query, [newValue, employeeID]));

            // If the column is like "course3Posttest", update "uCourse3"
            const match = columnName.match(/^course(\d+)Posttest$/);
            if (match && courseName) {
                const courseNumber = match[1];
                const uCourseColumn = `uCourse${courseNumber}`;

                const updateUCourse = connectionPromise.query(
                    `UPDATE users SET \`${uCourseColumn}\` = ? WHERE employeeID = ?`,
                    [courseName, employeeID]
                );
                updateTasks.push(updateUCourse);
            }
        }

        await Promise.all(updateTasks);
        res.status(200).json({ success: true, updated: updateTasks.length });
    } catch (error) {
        console.error('Batch update failed:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});*/




//this router for the save updating grades from the gradesmanagement 24-04-2025  with uniqueID

/*app.post('/saveChanges', async (req, res) => {
    const updates = req.body.updatedData;

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'No data received' });
    }

    const connectionPromise = connection.promise();
    const updateTasks = [];

    try {
        for (const entry of updates) {
            const { uniqueID, columnName, newValue, courseName } = entry;

            if (!uniqueID || !columnName) continue;

            // Update Posttest score
            const updateScoreQuery = `UPDATE users SET \`${columnName}\` = ? WHERE uniqueID = ?`;
            updateTasks.push(connectionPromise.query(updateScoreQuery, [newValue, uniqueID]));

            // Optionally update uCourseX column if courseName is provided
            const match = columnName.match(/^course(\d+)Posttest$/);
            if (match && courseName) {
                const courseNumber = match[1];
                const uCourseColumn = `uCourse${courseNumber}`;

                const updateUCourseQuery = `UPDATE users SET \`${uCourseColumn}\` = ? WHERE uniqueID = ?`;
                updateTasks.push(connectionPromise.query(updateUCourseQuery, [courseName, uniqueID]));
            }
        }

        await Promise.all(updateTasks);
        res.status(200).json({ success: true, updated: updateTasks.length });
    } catch (error) {
        console.error('Batch update failed:', error);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});*/





function getFormattedDateTimeIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  const hh = String(istNow.getHours()).padStart(2, '0');
  const min = String(istNow.getMinutes()).padStart(2, '0');
  const ss = String(istNow.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}


app.post('/saveChanges', async (req, res) => {
  const updates = req.body.updatedData;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'No data received' });
  }

  const connectionPromise = connection.promise();
  const updateTasks = [];

  try {
    for (const entry of updates) {
      const { uniqueID, columnName, newValue, oldValue, courseName } = entry;

      if (!uniqueID || !columnName) continue;

      // ✅ Only update if the value actually changed
      if (newValue === oldValue) continue;

      const match = columnName.match(/^course(\d+)Posttest$/);
      if (!match) continue;

      const courseNumber = match[1];

      // Update posttest score
      const updateScoreQuery = `UPDATE users SET \`${columnName}\` = ? WHERE uniqueID = ?`;
      updateTasks.push(connectionPromise.query(updateScoreQuery, [newValue, uniqueID]));

      // Update course name if provided
      if (courseName) {
        const uCourseColumn = `uCourse${courseNumber}`;
        const updateUCourseQuery = `UPDATE users SET \`${uCourseColumn}\` = ? WHERE uniqueID = ?`;
        updateTasks.push(connectionPromise.query(updateUCourseQuery, [courseName, uniqueID]));
      }

      // ✅ Update only that course's TrainDate
      const trainDateColumn = `course${courseNumber}TrainDate`;
      const trainDate = getFormattedDateTimeIST();
      const updateTrainDateQuery = `UPDATE users SET \`${trainDateColumn}\` = ? WHERE uniqueID = ?`;
      updateTasks.push(connectionPromise.query(updateTrainDateQuery, [trainDate, uniqueID]));
    }

    await Promise.all(updateTasks);
    res.status(200).json({ success: true, updated: updateTasks.length });
  } catch (error) {
    console.error('Batch update failed:', error);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});










function updateDatabase(employeeID, columnName, newValue) {
  const query = `UPDATE users SET ${columnName} = ? WHERE employeeID = ?`;
  connection.query(query, [newValue, employeeID], (error, results) => {
    if (error) {
      console.error('Error updating database:', error);
    } else {
      console.log('Database updated successfully');
    }
  });
}


// Route to handle saving changes
/*
app.post('/saveChanges', (req, res) => {
  const { updatedData } = req.body;

  // Loop through updated data and update corresponding records in the database
  // updatedData.forEach(data => {
  //   // Construct the column name based on the courseID
  //   //const mysqlColumnName = `uCourse${data.courseID}`;
  //   // Assuming you have a function to update the database
  //   updateDatabase(data.employeeID, data.columnName, data.newValue, data.courseName);
  // });

  updateDatabase(updatedData);
  // Send response
  res.sendStatus(200);
});

*/

function updateDatabase(updatedData) {
  updatedData.forEach(data => {
    // Check if columnName is defined before using startsWith
    if (data.columnName && data.columnName.startsWith('course')) {
      const courseNumber = data.columnName.match(/\d+/)[0];
      const uCourseColumnName = `uCourse${courseNumber}`;
      const query = `UPDATE users SET ${data.columnName} = ?, ${uCourseColumnName} = ? WHERE employeeID = ?`;
      connection.query(query, [data.newValue, data.courseName, data.employeeID], (error, results) => {
        if (error) {
          console.error('Error updating database:', error);
        } else {
          console.log('Database updated successfully');
        }
      });
    } else {
      const query = `UPDATE users SET ${data.columnName} = ? WHERE employeeID = ?`;
      connection.query(query, [data.newValue, data.employeeID], (error, results) => {
        if (error) {
          console.error('Error updating database:', error);
        } else {
          console.log('Database updated successfully');
        }
      });
    }
  });
}


// function updateDatabase(employeeID, columnName, newValue, courseName) {
//   const query = `UPDATE users SET ${columnName} = ?, uCourseName = ? WHERE employeeID = ?`;
//   connection.query(query, [newValue, courseName, employeeID], (error, results) => {
//     if (error) {
//       console.error('Error updating database:', error);
//     } else {
//       console.log('Database updated successfully');
//     }
//   });
// }



// Route to get list of course names
app.get('/courseNames', (req, res) => {
  // Use 'level' instead of 'courseLevel' to match your database column
  const query = 'SELECT courseID, courseName, level FROM courses'; 
  
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving course names:', error);
      return res.status(500).send('Internal Server Error');
    }

    // Map 'level' from database to 'courseLevel' for the frontend
    const courseNames = results.map(row => ({ 
      courseID: row.courseID, 
      courseName: row.courseName,
      courseLevel: row.level || '1' // Map database 'level' to 'courseLevel'
    }));

    // Send the course names as JSON response
    console.log("CourseNames = ", courseNames);
    res.json(courseNames);
  });
});



// This is for User Management page



// Route to handle saving changes
app.post('/userDetailsSaveChanges', (req, res) => {
  const updatedUserData = req.body;
  let allPromises = [];

  updatedUserData.forEach(data => {
    if (!data.columnName) {
      console.warn("Skipping update because columnName is missing:", data);
      return; // skip invalid entries
    }

    allPromises.push(new Promise((resolve, reject) => {
      const query = `UPDATE users SET ${data.columnName} = ? WHERE uniqueID = ?`;
      connection.query(query, [data.newValue, data.uniqueID], (error, results) => {
        if (error) {
          console.error('Error updating user database:', error);
          reject(error);
        } else {
          console.log('User Database updated successfully');
          resolve(results);
        }
      });
    }));
  });

  Promise.all(allPromises)
    .then(() => {
      res.sendStatus(200);
    })
    .catch((error) => {
      res.status(500).send('Error updating user database');
    });
});


function updateUserDatabase(uniqueID, newValue) {
  const query = `UPDATE users SET ${columnName} = ?, WHERE uniqueID = ?`;
  connection.query(query, [newValue, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user database:', error);
    } else {
      console.log('User Database updated successfully');
    }
  });
}




// // Route to handle Excel file upload and process MCQs
// app.post("/uploadExcel", uploadExcelAss.single("mcqFile"), (req, res) => {
//   let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;
//   const filePath = req.file.path;

//   const uploadPath = 'Excel Assessment';

//   // Read the uploaded Excel file
//   const workbook = xlsx.readFile(filePath);
//   const sheetName = workbook.SheetNames[0];
//   const worksheet = workbook.Sheets[sheetName];

//   // Parse the worksheet data into JSON
//   const jsonData = xlsx.utils.sheet_to_json(worksheet);

//   // Set courseTags to "default" if it is not provided
//   if (!courseTags || courseTags.trim() === '') {
//     courseTags = 'default';
//   }

//   // Generate HTML content for MCQs
//   let htmlContent = `
//     <h1>${courseName} (Course ID: ${courseID})</h1>
//     <form id="quiz-form">
//   `;

//   // Insert course data into the courses table
//   const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, courseTags) VALUES (?, ?, ?, ?, ?, ?)`;
//   connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, courseTags], (error, results) => {
//     if (error) {
//       console.error('Error saving course data:', error);
//       return res.status(500).send('Internal Server Error');
//     }
//     console.log('Course data saved successfully');

//     // Dynamically create column definitions
//     let columnDefinitions = `
//       id INT AUTO_INCREMENT PRIMARY KEY,
//       uniqueID VARCHAR(255) NOT NULL,
//       employeeID TEXT,
//       name TEXT,
//       noOfAttempts INT DEFAULT 0
//     `;

//     for (let i = 1; i <= 35; i++) {
//       columnDefinitions += `,
//         course_${courseID}_Posttest${i} LONGTEXT,
//         score${i} LONGTEXT,
//         status${i} LONGTEXT,
//         duration${i} LONGTEXT
//       `;
//     }

//     const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;


//     connection.query(createTableQuery, (err) => {
//       if (err) {
//         console.error('Error creating course table:', err);
//         return res.status(500).send('Error creating course table');
//       }
//       console.log(`Table course_${courseID} created successfully`);

//       // Query the users table to get uniqueID, employeeID, and name
//       const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

//       connection.query(selectUsersQuery, (err, users) => {
//         if (err) {
//           console.error('Error fetching users data:', err);
//           return res.status(500).send('Error fetching users data');
//         }

//         // Insert data into course_${courseID} table
//         const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
//         const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

//         connection.query(insertUserData, [userData], (err) => {
//           if (err) {
//             console.error('Error inserting user data:', err);
//             return res.status(500).send('Error inserting user data');
//           }
//           console.log(`User data inserted into course_${courseID} successfully`);

//           // Send JavaScript response to show alert message and redirect back to the upload page
//           const script = `
//             <script>
//               const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
//               if (uploadConfirmation) {
//                   window.location.href = '/'; // Redirect to the upload page
//               }
//             </script>
//           `;
//           jsonData.forEach((row, index) => {
//             htmlContent += `
//               <div class="question">
//                 <p><strong>${index + 1}. ${row.questionText}</strong></p>
//                 <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
//                 <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
//                 <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
//                 <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
//               </div>
//             `;
//           });

//           htmlContent += `<button type="submit">Submit</button></form>`;

//           // Save HTML file
//           const htmlFilePath = path.join(__dirname, "Excel Assessment", "Assessment pages", `${courseID}_quiz.html`);
//           fs.writeFileSync(htmlFilePath, htmlContent);

//           // Respond with success and reload the page
//           res.send(`
//             <p>File uploaded and quiz generated successfully!</p>
//             <a href="/">Upload another file</a> | 
//             <a href="/quiz/${courseID}">View Quiz</a>
//           `);
//           res.send(script);
//         });
//       });
//     });
//   });


// });

// Route to handle Excel file upload and process MCQs
/*app.post("/uploadExcel", uploadExcelAss.single("mcqFile"), (req, res) => {
  let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;
  const filePath = req.file.path;

  const uploadPath = 'Excel Assessment';

  // Read the uploaded Excel file
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Parse the worksheet data into JSON
  const jsonData = xlsx.utils.sheet_to_json(worksheet);

  // Set courseTags to "default" if it is not provided
  if (!courseTags || courseTags.trim() === '') {
    courseTags = 'default';
  }

  // Generate HTML content for MCQs
  let htmlContent = `
    <h1>${courseName} (Course ID: ${courseID})</h1>
    <form id="quiz-form">
  `;

  // Insert course data into the courses table
  const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, courseTags) VALUES (?, ?, ?, ?, ?, ?)`;
  connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, courseTags], (error, results) => {
    if (error) {
      console.error('Error saving course data:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Course data saved successfully');

    // Dynamically create column definitions
    let columnDefinitions = `
      id INT AUTO_INCREMENT PRIMARY KEY,
      uniqueID VARCHAR(255) NOT NULL,
      employeeID TEXT,
      name TEXT,
      noOfAttempts INT DEFAULT 0
    `;

    for (let i = 1; i <= 35; i++) {
      columnDefinitions += `,
        course_${courseID}_Posttest${i} LONGTEXT,
        score${i} LONGTEXT,
        status${i} LONGTEXT,
        duration${i} LONGTEXT
      `;
    }

    const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

    connection.query(createTableQuery, (err) => {
      if (err) {
        console.error('Error creating course table:', err);
        return res.status(500).send('Error creating course table');
      }
      console.log(`Table course_${courseID} created successfully`);

      // Query the users table to get uniqueID, employeeID, and name
      const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

      connection.query(selectUsersQuery, (err, users) => {
        if (err) {
          console.error('Error fetching users data:', err);
          return res.status(500).send('Error fetching users data');
        }

        // Insert data into course_${courseID} table
        const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
        const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

        connection.query(insertUserData, [userData], (err) => {
          if (err) {
            console.error('Error inserting user data:', err);
            return res.status(500).send('Error inserting user data');
          }
          console.log(`User data inserted into course_${courseID} successfully`);

          // Generate HTML for each question in jsonData
          jsonData.forEach((row, index) => {
            htmlContent += `
              <div class="question">
                <p><strong>${index + 1}. ${row.questionText}</strong></p>
                <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
                <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
                <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
                <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
              </div>
            `;
          });

          htmlContent += `<button type="submit">Submit</button></form>`;

          // Save HTML file
          const htmlFilePath = path.join(__dirname, "Excel Assessment", "Assessment pages", `${courseID}_quiz.html`);
          fs.writeFileSync(htmlFilePath, htmlContent);

          // Send final response with HTML and JavaScript combined
          res.send(`
            <p>File uploaded and quiz generated successfully!</p>
            <a href="/">Upload another file</a> | 
            <a href="/quiz/${courseID}">View Quiz</a>
            <script>
              const uploadConfirmation = confirm('Course uploaded, table created, and user data inserted successfully. Click OK to return to the upload page.');
              if (uploadConfirmation) {
                  // <p>File uploaded and quiz generated successfully!</p>
                  // <a href="/createCourse">Upload another file</a> | 
                  // <a href="/quiz/${courseID}">View Quiz</a>
                  window.location.href = '/createCourse.html';
              }
            </script>
          `);
        });
      });
    });
  });
});*/

// Route to handle Excel file upload and process MCQs
app.post("/uploadExcel", uploadExcelAss.single("mcqFile"), (req, res) => {
  let { courseID, courseName, courseDescription, courseDate, level, department } = req.body;
  const filePath = req.file.path;

  const uploadPath = 'Excel Assessment/Assessment pages';

  // Read the uploaded Excel file
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Parse the worksheet data into JSON
  const jsonData = xlsx.utils.sheet_to_json(worksheet);

  // Set courseTags to "default" if it is not provided
  if (!level || level.trim() === '') {
    level = 'default';
  }

  // Read the HTML template
  const templatePath = path.join(__dirname, "public", "excelAss_Template.html");
  let template = fs.readFileSync(templatePath, "utf-8");

  // // Generate HTML content for MCQs
  // let htmlContent = `
  //   <h1>${courseName} (Course ID: ${courseID})</h1>
  //   <form id="quiz-form">
  // `;

  // Insert course data into the courses table
  const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, department) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, level, department], (error, results) => {
    if (error) {
      console.error('Error saving course data:', error);
      return res.status(500).send('Internal Server Error');
    }
    console.log('Course data saved successfully');

    // Dynamically create column definitions
    let columnDefinitions = `
      id INT AUTO_INCREMENT PRIMARY KEY,
      uniqueID VARCHAR(255) NOT NULL,
      employeeID TEXT,
      name TEXT,
      noOfAttempts INT DEFAULT 0
    `;

    for (let i = 1; i <= 27; i++) {
      columnDefinitions += `,
        course_${courseID}_Posttest${i} LONGTEXT,
        score${i} LONGTEXT,
        status${i} LONGTEXT,
        duration${i} LONGTEXT,
        date${i} TEXT
      `;
    }

    const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

    connection.query(createTableQuery, (err) => {
      if (err) {
        console.error('Error creating course table:', err);
        return res.status(500).send('Error creating course table');
      }
      console.log(`Table course_${courseID} created successfully`);

      // Query the users table to get uniqueID, employeeID, and name
      const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

      connection.query(selectUsersQuery, (err, users) => {
        if (err) {
          console.error('Error fetching users data:', err);
          return res.status(500).send('Error fetching users data');
        }

        // Insert data into course_${courseID} table
        const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
        const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

        connection.query(insertUserData, [userData], (err) => {
          if (err) {
            console.error('Error inserting user data:', err);
            return res.status(500).send('Error inserting user data');
          }
          console.log(`User data inserted into course_${courseID} successfully`);

          // Generate HTML content for questions
          let quizQuestions = "";
          jsonData.forEach((row, index) => {
            quizQuestions += `
               <div class="question" data-correct-answer="${row.answerText}">
                   <p><strong>${index + 1}. ${row.questionText}</strong></p>
                   <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
                   <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
                   <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
                   <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
               </div>
           `;
          });
          // // Generate HTML for each question in jsonData
          // jsonData.forEach((row, index) => {
          //   htmlContent += `
          //   <body>
          //         <div class="question">
          //           <p><strong>${index + 1}. ${row.questionText}</strong></p>
          //           <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
          //           <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
          //           <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
          //           <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
          //         </div>
          //         <script>
          //             // Send variables to the browser after 5 seconds
          //             setTimeout(() => {
          //                 const posttestScore = 0;
          //                 const status = 'attempted';
          //                 const score = 0;
          //                 const duration = 0;

          //                 // Example: Log to console
          //                 console.log({ posttestScore, status, score, duration });
          //                 window.parent.postMessage({ 
          //                     posttestScore: posttestScore
          //                 }, "*");

          //                 // // Example: Store in localStorage
          //                 // localStorage.setItem('posttestScore', posttestScore);
          //                 // localStorage.setItem('status', status);
          //                 // localStorage.setItem('score', score);
          //                 // localStorage.setItem('duration', duration);
          //             }, 5000); // 5000ms = 5 seconds
          //         </script>
          //     </body>
          //   `;
          // });

          // htmlContent += `<button type="submit">Submit</button></form>`;

          // Replace placeholders in the template
          const finalQuizHTML = template
            .replace(/{{courseName}}/g, courseName)
            .replace(/{{courseID}}/g, courseID)
            .replace(/{{quizQuestions}}/g, quizQuestions);

          // Save HTML file
          const htmlFilePath = path.join(__dirname, "uploads", "Excel Assessment", "Assessment pages", `${courseID}_quiz.html`);
          fs.writeFileSync(htmlFilePath, finalQuizHTML);

          // Send final response with HTML and JavaScript combined
          res.send(`
            <p>File uploaded and quiz generated successfully!</p>
            <a href="/">Upload another file</a> | 
            <a href="/quiz/${courseID}">View Quiz</a>
            <script>
              const uploadConfirmation = confirm('Course uploaded successfully.');
              if (uploadConfirmation) {
                  // <p>File uploaded and quiz generated successfully!</p>
                  // <a href="/createCourse">Upload another file</a> | 
                  // <a href="/quiz/${courseID}">View Quiz</a>
                  window.location.href = '/createCourse.html';
              }
            </script>
          `);
        });
      });
    });
  });
});





// Route to serve the generated HTML quiz page
app.get("/quiz/:courseID", (req, res) => {
  const htmlFilePath = path.join(__dirname, "uploads", "Excel Assessment", "Assessment pages", `${req.params.courseID}_quiz.html`);
  if (fs.existsSync(htmlFilePath)) {
    res.sendFile(htmlFilePath);
  } else {
    res.status(404).send("Quiz not found.");
  }
});







// Route to handle Excel file upload and process MCQs
// app.post("/uploadTraining", uploadFiles, (req, res) => {

//   console.log("Files received:", req.files);
//   console.log("Body received:", req.body);

//   let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;

//   const mcqFile = req.files.mcqFile?.[0];
//   const videoFile = req.files["videoFile"]?.[0];

//   if (!mcqFile) {
//     return res.status(400).send("MCQ file is missing!");
//   }
//   const mcqFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", `${Date.now()}_${mcqFile.originalname}`);
//   const videoFilePath = videoFile
//     // ? path.join(__dirname, "uploads", "Training Assessment", "Videos", `${Date.now()}_${videoFile.originalname}`)
//     ? path.join(__dirname, "uploads", "Training Assessment", "Videos", `${courseID}_video.mp4`)
//     : null;

//   try {
//     fs.writeFileSync(mcqFilePath, mcqFile.buffer);
//     console.log(`MCQ file saved at: ${mcqFilePath}`);

//     if (!fs.existsSync(mcqFilePath)) {
//       throw new Error("MCQ file path is invalid!");
//     }
//     //const videoFile = req.files.videoFile[0];

//     //const filePath = mcqFile.path;

//     const uploadPath = 'uploads/Training Assessment/Posttest assessment/training pages';

//     // Read the uploaded Excel file
//     const workbook = xlsx.readFile(mcqFilePath);
//     const sheetName = workbook.SheetNames[0];
//     const worksheet = workbook.Sheets[sheetName];

//     // Handle video file

//     if (videoFile) {
//       fs.writeFileSync(videoFilePath, videoFile.buffer);
//       console.log(`Video file saved at: ${videoFilePath}`);
//       const videoPath = path.join("uploads", "Training Assessment", "Videos");
//       console.log(`Video saved at: ${videoPath}`);
//     }
//     // Parse the worksheet data into JSON
//     const jsonData = xlsx.utils.sheet_to_json(worksheet);

//     // Set courseTags to "default" if it is not provided
//     if (!courseTags || courseTags.trim() === '') {
//       courseTags = 'default';
//     }

//     // Read the HTML template
//     const templatePath = path.join(__dirname, "public", "trainingAss_Template.html");
//     let template = fs.readFileSync(templatePath, "utf-8");
//     const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, courseTags) VALUES (?, ?, ?, ?, ?, ?)`;
//     connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, courseTags], (error, results) => {
//       if (error) {
//         console.error('Error saving course data:', error);
//         return res.status(500).send('Internal Server Error');
//       }
//       console.log('Course data saved successfully');

//       // Dynamically create column definitions
//       let columnDefinitions = `
//       id INT AUTO_INCREMENT PRIMARY KEY,
//       uniqueID VARCHAR(255) NOT NULL,
//       employeeID TEXT,
//       name TEXT,
//       noOfAttempts INT DEFAULT 0
//     `;

//       for (let i = 1; i <= 27; i++) {
//         columnDefinitions += `,
//         course_${courseID}_Posttest${i} LONGTEXT,
//         score${i} LONGTEXT,
//         status${i} LONGTEXT,
//         duration${i} LONGTEXT,
//         date${i} TEXT
//       `;
//       }

//       const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

//       connection.query(createTableQuery, (err) => {
//         if (err) {
//           console.error('Error creating course table:', err);
//           return res.status(500).send('Error creating course table');
//         }
//         console.log(`Table course_${courseID} created successfully`);

//         // Query the users table to get uniqueID, employeeID, and name
//         const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;

//         connection.query(selectUsersQuery, (err, users) => {
//           if (err) {
//             console.error('Error fetching users data:', err);
//             return res.status(500).send('Error fetching users data');
//           }

//           // Insert data into course_${courseID} table
//           const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
//           const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);

//           connection.query(insertUserData, [userData], (err) => {
//             if (err) {
//               console.error('Error inserting user data:', err);
//               return res.status(500).send('Error inserting user data');
//             }
//             console.log(`User data inserted into course_${courseID} successfully`);

//             // Generate HTML content for questions
//             let quizQuestions = "";
//             jsonData.forEach((row, index) => {
//               quizQuestions += `
//                <div class="question" data-correct-answer="${row.answerText}">
//                    <p><strong>${index + 1}. ${row.questionText}</strong></p>
//                    <label><input type="radio" name="question${index}" value="${row.option1Text}"> ${row.option1Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option2Text}"> ${row.option2Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option3Text}"> ${row.option3Text}</label><br>
//                    <label><input type="radio" name="question${index}" value="${row.option4Text}"> ${row.option4Text}</label><br>
//                </div>
//            `;
//             });

//             // Replace placeholders in the template
//             const finalQuizHTML = template
//               .replace(/{{courseName}}/g, courseName)
//               .replace(/{{courseID}}/g, courseID)
//               .replace(/{{quizQuestions}}/g, quizQuestions);

//             // Save HTML file
//             const htmlFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", "training pages", `${courseID}_quiz.html`);
//             fs.writeFileSync(htmlFilePath, finalQuizHTML);

//             // Send final response with HTML and JavaScript combined
//             res.send(`
//             <p>File uploaded and quiz generated successfully!</p>
//             <a href="/">Upload another file</a> | 
//             <a href="/training/${courseID}">View Quiz</a>
//             <script>
//               const uploadConfirmation = confirm('Course uploaded successfully.');
//               if (uploadConfirmation) {
//                   // <p>File uploaded and quiz generated successfully!</p>
//                   // <a href="/createCourse">Upload another file</a> | 
//                   // <a href="/training/${courseID}">View Quiz</a>
//                   window.location.href = '/createCourse.html';
//               }
//             </script>
//           `);
//           });
//         });
//       });
//     });
//   }
//   catch (err) {
//     console.error("Error processing files:", err);
//     res.status(500).send("Error processing uploaded files.");
//   }


// });
app.get('/getDepartments', (req, res) => {
  // Query to fetch departments from the database
  const query = 'SELECT id, departmentName FROM department';

  // Execute the query
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching departments:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Format the results to match the expected structure
    const departments = results.map(row => ({
      id: row.id,
      name: row.departmentName
    }));

    // Send the departments as a JSON response
    res.json({ departments });
  });
});
app.get('/getLevels', (req, res) => {
  const query = 'SELECT id, levelName FROM levels';

  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching levels:', error);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const levels = results.map(row => ({
      id: row.id,
      name: row.levelName
    }));

    res.json({ levels });
  });
});




app.post("/uploadTraining", uploadFiles, (req, res) => {
    console.log("Files received:", req.files);
    console.log("Body received:", req.body);

    let { courseID, courseName, courseDescription, courseDate, level, department } = req.body;

    const mcqFile = req.files.mcqFile?.[0];
    const videoFile = req.files["videoFile"]?.[0];

    if (!mcqFile) {
        return res.status(400).send("MCQ file is missing!");
    }

    // --- NEW: Dynamic Folder Creation and Path Definition ---
    const courseFolder = `${courseID}_course`;
    const baseUploadDir = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment");
    const coursePath = path.join(baseUploadDir, courseFolder);

    // Ensure the course-specific folder exists
    if (!fs.existsSync(coursePath)) {
        fs.mkdirSync(coursePath, { recursive: true });
        console.log(`Course directory created at: ${coursePath}`);
    }

    // Define new file paths within the dynamic folder
    const mcqFilePath = path.join(coursePath, `${Date.now()}_${mcqFile.originalname}`);
    const videoFilePath = videoFile
        ? path.join(coursePath, `${courseID}_video.mp4`)
        : null;
    // --- END NEW: Dynamic Folder Creation and Path Definition ---

    try {
        // Save MCQ file to the new location
        fs.writeFileSync(mcqFilePath, mcqFile.buffer);
        console.log(`MCQ file saved at: ${mcqFilePath}`);

        if (!fs.existsSync(mcqFilePath)) {
            throw new Error("MCQ file path is invalid!");
        }

        // Handle video file saving to the new location
        if (videoFile) {
            fs.writeFileSync(videoFilePath, videoFile.buffer);
            console.log(`Video file saved at: ${videoFilePath}`);
        }

        // Read the uploaded Excel file
        const workbook = xlsx.readFile(mcqFilePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Parse the worksheet data into JSON
        const jsonData = xlsx.utils.sheet_to_json(worksheet);

        // Set courseTags to "default" if it is not provided
        if (!level || level.trim() === '') {
            level = 'default';
        }

        // Read the HTML template
        const templatePath = path.join(__dirname, "public", "trainingAss_Template.html");
        let template = fs.readFileSync(templatePath, "utf-8");

        // --- NEW: Update scormPath to the new dynamic folder ---
        const uploadPath = `uploads/Training Assessment/Posttest assessment/${courseFolder}`;
        const query = `INSERT INTO courses (courseName, courseDescription, courseDate, scormPath, courseID, level, department) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        connection.query(query, [courseName, courseDescription, courseDate, uploadPath, courseID, level, department], (error, results) => {
            if (error) {
                console.error('Error saving course data:', error);
                return res.status(500).send('Internal Server Error');
            }
            console.log('Course data saved successfully');

            // Dynamically create column definitions
            let columnDefinitions = `
                id INT AUTO_INCREMENT PRIMARY KEY,
                uniqueID VARCHAR(255) NOT NULL,
                employeeID TEXT,
                name TEXT,
                noOfAttempts INT DEFAULT 0
            `;

            for (let i = 1; i <= 27; i++) {
                columnDefinitions += `,
                    course_${courseID}_Posttest${i} LONGTEXT,
                    score${i} LONGTEXT,
                    status${i} LONGTEXT,
                    duration${i} LONGTEXT,
                    date${i} TEXT
                `;
            }

            const createTableQuery = `CREATE TABLE IF NOT EXISTS course_${courseID} (${columnDefinitions});`;

            connection.query(createTableQuery, (err) => {
                if (err) {
                    console.error('Error creating course table:', err);
                    return res.status(500).send('Error creating course table');
                }
                console.log(`Table course_${courseID} created successfully`);

                // ----------------------------------------------
                // COMMENTED OUT: Auto-insert all users into the course table
                // const selectUsersQuery = `SELECT uniqueID, employeeID, name FROM users`;
                // connection.query(selectUsersQuery, (err, users) => {
                //     if (err) {
                //         console.error('Error fetching users data:', err);
                //         return res.status(500).send('Error fetching users data');
                //     }
                //     const insertUserData = `INSERT INTO course_${courseID} (uniqueID, employeeID, name) VALUES ?`;
                //     const userData = users.map(user => [user.uniqueID, user.employeeID, user.name]);
                //     connection.query(insertUserData, [userData], (err) => {
                //         if (err) {
                //             console.error('Error inserting user data:', err);
                //             return res.status(500).send('Error inserting user data');
                //         }
                //         console.log(`User data inserted into course_${courseID} successfully`);
                //     });
                // });
                // ----------------------------------------------

                // --- Generate Quiz HTML from Excel ---
                let quizQuestions = "";
                jsonData.forEach((row, index) => {
                    const answerKey = {
                        'A': row.option1Text,
                        'B': row.option2Text,
                        'C': row.option3Text,
                        'D': row.option4Text
                    };
                    const correctAnswerText = answerKey[String(row.answerText).trim().toUpperCase()];

                    const escapeAttr = (text) => String(text).replace(/"/g, '&quot;');
                    const escapeHTML = (text) => String(text);

                    quizQuestions += `
                       <div class="question" data-question-number="${index + 1}" data-correct-answer="${escapeAttr(correctAnswerText)}">
                            <p><strong>${index + 1}. ${escapeHTML(row.questionText)}</strong></p>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option1Text)}"> ${escapeHTML(row.option1Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option2Text)}"> ${escapeHTML(row.option2Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option3Text)}"> ${escapeHTML(row.option3Text)}</label><br>
                            <label><input type="radio" name="question${index}" value="${escapeAttr(row.option4Text)}"> ${escapeHTML(row.option4Text)}</label><br>
                       </div>
                    `;
                });

                // Replace placeholders in the template
                const finalQuizHTML = template
                    .replace(/{{courseName}}/g, courseName)
                    .replace(/{{courseID}}/g, courseID)
                    .replace(/{{quizQuestions}}/g, quizQuestions);

                // Save HTML file to the new location
                const htmlFilePath = path.join(coursePath, `${courseID}_quiz.html`);
                fs.writeFileSync(htmlFilePath, finalQuizHTML);

                // Send final response
                res.send(`
                    <p>File uploaded and quiz generated successfully!</p>
                    <a href="/">Upload another file</a> | 
                    <a href="/training/${courseID}">View Quiz</a>
                    <script>
                        const uploadConfirmation = confirm('Course uploaded and table created successfully.');
                        if (uploadConfirmation) {
                            window.location.href = '/createCourse.html';
                        }
                    </script>
                `);
            });
        });
    }
    catch (err) {
        console.error("Error processing files:", err);
        res.status(500).send("Error processing uploaded files.");
    }
});



app.post("/submitScore/:courseID", (req, res) => {
    const { courseID } = req.params;
    const { score, status, uniqueID, courseName } = req.body;

    if (!uniqueID) return res.status(400).send("uniqueID is required");

    const tableName = `course_${courseID}`;
    const coursePosttestColumn = `course${courseID}Posttest`;
    const courseTrainDateColumn = `course${courseID}TrainDate`;
    const uCourseColumn = `uCourse${courseID}`;

    const updateCourseQuery = `
        UPDATE ?? 
        SET score1 = ?, status1 = ?, date1 = NOW() 
        WHERE uniqueID = ?`;

    connection.query(updateCourseQuery, [tableName, score, status, uniqueID], (err) => {
        if (err) {
            console.error("Error updating course table:", err);
            return res.status(500).send("DB update error");
        }

        const updateUserQuery = `
            UPDATE users
            SET ?? = ?, ?? = ?, ?? = NOW()
            WHERE uniqueID = ?`;

        connection.query(updateUserQuery, [
            uCourseColumn, courseName,
            coursePosttestColumn, score,
            courseTrainDateColumn, uniqueID
        ], (err2) => {
            if (err2) {
                console.error("Error updating users table:", err2);
                return res.status(500).send("DB update error users table");
            }

            res.send({ success: true });
        });
    });
});


app.get('/api/get-current-user', (req, res) => {
  if (!req.session || !req.session.user || !req.session.user.uniqueID) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  const uniqueID = req.session.user.uniqueID;

  // Query to get user details
  const query = 'SELECT uniqueID, employeeID, name FROM users WHERE uniqueID = ? LIMIT 1';
  
  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error fetching user data:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(results[0]); // Return user data: uniqueID, employeeID, name
  });
});


app.post("/updateScore", (req, res) => {
    const { courseID, userUniqueID, score } = req.body;

    if (!courseID || !userUniqueID) {
        return res.status(400).json({ success: false, error: "Missing courseID or userUniqueID" });
    }

    const tableName = `course_${courseID}`;

    const sql = `
        UPDATE ${tableName}
        SET score1 = ?, status1 = 'completed', date1 = NOW()
        WHERE uniqueID = ?
    `;

    connection.query(sql, [score, userUniqueID], (err, result) => {
        if (err) {
            console.error("Error updating score:", err);
            return res.json({ success: false, error: err.message });
        }
        res.json({ success: true });
    });
});



//New Code for wheh user clicks on name then userdata.html open start here 
app.get('/UserDataAd', (req, res) => {
  const uniqueID = req.query.uniqueID;

  if (!uniqueID) {
    return res.status(400).json({ error: "uniqueID is required" });
  }

  const query = `
        SELECT 
            uniqueID,
            name,
            emailID,
            employeeID,
            uName,
            uPass,
            mobileNo,
            dateOfBirth,
            address,
            dateOfJoining,
            department,
            contractorName,
            uRole,
            currentDate,
            status,
            photo
        FROM users
        WHERE uniqueID = ?
    `;

  connection.query(query, [uniqueID], (err, results) => {
    if (err) {
      console.error("Error fetching user:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // ✅ Return single object (not array)
    res.json(results[0]);
  });
});

//New Code for wheh user clicks on name then userdata.html open end here


// Route to serve the generated HTML quiz page
app.get("/training/:courseID", (req, res) => {
  const htmlFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", "training pages", `${req.params.courseID}_quiz.html`);
  if (fs.existsSync(htmlFilePath)) {
    res.sendFile(htmlFilePath);
  } else {
    res.status(404).send("Quiz not found.");
  }
});

//Function for search user functionality 23-07-25
app.get('/searchUsers', (req, res) => {
  const searchTerm = req.query.term;
  const query = `
    SELECT uniqueID, name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, Contract, Qualification, uRole, currentDate
    FROM users
    WHERE name LIKE ? OR emailID LIKE ? OR employeeID LIKE ? OR uName LIKE ? OR uPass LIKE ? OR mobileNo LIKE ? OR dateOfBirth LIKE ? OR address LIKE ? OR department LIKE ? OR Contract LIKE ? OR Qualification LIKE ? OR uRole LIKE ? OR currentDate LIKE ?
  `;

  const wildcardTerm = `%${searchTerm}%`;
  const params = Array(13).fill(wildcardTerm);

  connection.query(query, params, (err, results) => {
    if (err) {
      console.error('Search query failed:', err);
      return res.status(500).send('Internal Server Error');
    }
    res.json(results);
  });
});









//backup data

// Function to convert an array of objects into a CSV string
const convertToCsv = (data) => {
  if (!data || data.length === 0) {
    return '';
  }

  // Get the headers from the keys of the first object
  const headers = Object.keys(data[0]);
  const headerRow = headers.join(',');

  // Map each object to a row of comma-separated values
  const dataRows = data.map(row => {
    return headers.map(header => {
      // Ensure values with commas or quotes are properly escaped
      const value = row[header] === null || row[header] === undefined ? '' : String(row[header]);
      return `"${value.replace(/"/g, '""')}"`;
    }).join(',');
  });

  return `${headerRow}\n${dataRows.join('\n')}`;
};

// Function to convert an array of objects into a series of SQL INSERT statements
const convertToSql = (data, tableName) => {
  if (!data || data.length === 0) {
    return '';
  }

  const headers = Object.keys(data[0]);
  const columnNames = headers.map(h => `\`${h}\``).join(', ');
  const sqlStatements = data.map(row => {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) {
        return 'NULL';
      } else if (typeof value === 'string') {
        // Escape single quotes for SQL
        return `'${value.replace(/'/g, "''")}'`;
      } else {
        return value;
      }
    }).join(', ');
    return `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${values});`;
  });

  return sqlStatements.join('\n');
};

// Function to get all table names from the database
const getAllTableNames = async () => {
  const [rows] = await connection.promise().query('SHOW TABLES');
  // The table names are in the first column of the result set
  const tableNames = rows.map(row => Object.values(row)[0]);
  return tableNames;
};

// API endpoint to download data as CSV
app.get('/api/backup/csv', async (req, res) => {
  try {
    const tableNames = await getAllTableNames();
    let allCsvData = '';

    for (const tableName of tableNames) {
      // Fetch data for the current table
      const [rows] = await connection.promise().query(`SELECT * FROM \`${tableName}\``);

      // Add a header for each table in the CSV
      allCsvData += `\n\n# --- TABLE: ${tableName} ---\n`;
      allCsvData += convertToCsv(rows);
    }

    // Set the appropriate headers for a CSV file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="database_backup.csv"');

    // Send the generated CSV data
    res.send(allCsvData);

  } catch (error) {
    console.error('Error during CSV backup:', error);
    res.status(500).send('An error occurred during CSV backup.');
  }
});

// API endpoint to download data as SQL
app.get('/api/backup/sql', async (req, res) => {
  try {
    const tableNames = await getAllTableNames();
    let allSqlData = '-- Database Backup\n\n';

    for (const tableName of tableNames) {
      // Fetch data for the current table
      const [rows] = await connection.promise().query(`SELECT * FROM \`${tableName}\``);

      // Add a comment header for each table in the SQL file
      allSqlData += `--\n-- Data for table: \`${tableName}\`\n--\n`;
      allSqlData += convertToSql(rows, tableName);
      allSqlData += '\n\n'; // Add spacing between tables
    }

    // Set the appropriate headers for a SQL file download
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename="database_backup.sql"');

    // Send the generated SQL data
    res.send(allSqlData);

  } catch (error) {
    console.error('Error during SQL backup:', error);
    res.status(500).send('An error occurred during SQL backup.');
  }
});


app.post('/api/grades/download/csv', (req, res) => {
  try {
    const gradesData = req.body;

    if (!gradesData || gradesData.length === 0) {
      return res.status(400).send('No data provided for download.');
    }

    const csvData = convertToCsv(gradesData);

    // Set the response headers to trigger a file download in the browser.
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="filtered_grades_data.csv"`);
    res.send(csvData);

  } catch (error) {
    console.error('Error during all grades backup:', error);
    res.status(500).send('An error occurred during all grades backup.');
  }
});




app.post('/api/grades/monthly/csv', (req, res) => {
  try {
    const gradesData = req.body;

    if (!gradesData || gradesData.length === 0) {
      return res.status(400).send('No monthly data provided for download.');
    }

    // The filename can be dynamic based on the data sent from the client
    const filename = `monthly_grades.csv`;

    const csvData = convertToCsv(gradesData);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);

  } catch (error) {
    console.error('Error during monthly CSV download:', error);
    res.status(500).send('An error occurred during monthly CSV download.');
  }
});



// extra work for the download

app.get('/api/users-csv', (req, res) => {
  // ✅ Only fetch required columns
  connection.query('SELECT id, name, emailID, employeeID, uName, uPass, mobileNo,dateOfBirth,address,dateOfJoining,department,ContractorName,Qualification,uRole,currentDate FROM users', (err, results) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).send('Database error');
    }

    if (!results || results.length === 0) {
      return res.status(404).send('No user data found');
    }

    try {
      const fields = ['id', 'name', 'emailID', 'employeeID', 'uName', 'uPass', 'mobileNo', 'dateOfBirth', 'address', 'dateOfJoining', 'department', 'ContractorName', 'Qualification', 'uRole', 'currentDate']; // ✅ CSV columns
      const parser = new Parser({ fields });
      const csv = parser.parse(results);

      res.header('Content-Type', 'text/csv');
      res.attachment('users_data.csv');
      res.send(csv);
    } catch (csvErr) {
      console.error('CSV error:', csvErr);
      res.status(500).send('CSV generation failed');
    }
  });
});

//route for the saving data from the user profile date 3/10/2025
app.put('/updateUserData', (req, res) => {
  // Destructure fields from the request body (sent as x-www-form-urlencoded)
  const {
    uniqueID,
    name,
    emailID,
    employeeID,
    uName,
    uPass,
    mobileNo,
    dateOfBirth,
    address,
    dateOfJoining,
    department,
    Qualification,
    Contract,
    uRole,
    level,
    newPhotoName // Contains the new filename OR the original filename
  } = req.body;

  // Basic validation
  if (!uniqueID || !uName || !uPass) {
    return res.status(400).json({ error: 'Missing critical user fields (ID, Username, or Password).' });
  }

  // SQL UPDATE statement
  const query = `
        UPDATE users SET
            name = ?,
            emailID = ?,
            employeeID = ?,
            uName = ?,
            uPass = ?,
            mobileNo = ?,
            dateOfBirth = ?,
            address = ?,
            dateOfJoining = ?,
            department = ?,
            Qualification = ?,
            Contract = ?,
            uRole = ?,
            level = ?,
            photo = ?
        WHERE uniqueID = ?
    `;

  // Parameters for the SQL query
  const params = [
    name,
    emailID,
    employeeID,
    uName,
    uPass,
    mobileNo,
    dateOfBirth,
    address,
    dateOfJoining,
    department,
    Qualification,
    Contract,
    uRole,
    level,
    newPhotoName,
    uniqueID // WHERE clause identifier
  ];

  connection.query(query, params, (error, results) => {
    if (error) {
      console.error('Database error during user update:', error);
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Username or Employee ID already exists.' });
      }
      return res.status(500).json({ error: 'Internal Server Error while updating user data.' });
    }

    if (results.affectedRows === 0) {
      // User not found or no fields were actually changed
      return res.status(404).json({ error: 'User not found or no changes made.' });
    }

    console.log(`User ${uniqueID} updated successfully with photo: ${newPhotoName}`);
    res.json({ message: 'User data updated successfully.' });
  });
});



app.get('/download-training-report', (req, res) => {
  const { date } = req.query; // YYYY-MM-DD

  if (!date) {
    return res.status(400).json({ error: "Date parameter is required (format: YYYY-MM-DD)" });
  }

  // Maximum number of courses (adjust if you add more later)
  const maxCourses = 50;

  let unions = [];
  for (let i = 1; i <= maxCourses; i++) {
    unions.push(`
      SELECT uniqueID, name, emailID, employeeID, department, uRole,
             uCourse${i} AS courseName,
             course${i}TrainDate AS trainDate,
             course${i}Posttest AS score
      FROM users
      WHERE DATE(course${i}TrainDate) = ?
    `);
  }

  // Join all UNION queries
  const query = unions.join(" UNION ALL ");

  // Build parameter array → repeat `date` for each course
  const params = Array(maxCourses).fill(date);

  connection.query(query, params, (err, results) => {
    if (err) {
      console.error("Error fetching report:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }

    if (!results.length) {
      return res.json({ message: "No users found for this date" });
    }

    // Convert results into worksheet
    const worksheetData = [
      [
        "User ID",
        "Name",
        "Email",
        "Employee ID",
        "Department",
        "Role",
        "Course",
        "Training Date",
        "Score",
      ],
      ...results.map(row => [
        row.uniqueID,
        row.name,
        row.emailID,
        row.employeeID,
        row.department,
        row.uRole,
        row.courseName,
        row.trainDate ? new Date(row.trainDate).toISOString().slice(0, 10) : "",
        row.score,
      ])
    ];

    const worksheet = xlsx.utils.aoa_to_sheet(worksheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Training Report");

    // Generate buffer
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Training_Report_${date}.xlsx`
    );

    res.send(buffer);
  });
});

//contract users backend routes 

// Save single contract user
app.post('/save-contract-user', async (req, res) => {
  let {
    name, dateOfJoining, mobileNo, Contract
  } = req.body;

  const uniqueID = uuidv4();

  // Use photo filename from frontend if available
  const photoFileName = req.body.photoFileName || 'default.png';
  const photo_filename = path.join(__dirname, 'public', 'photos', photoFileName);

  try {
    await connection.promise().query(
      `INSERT INTO users 
      (id, uniqueID, name, dateOfJoining, mobileNo, Contract, photo, photo_filename, currentDate) 
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uniqueID, name, dateOfJoining, mobileNo, Contract,
        photoFileName, photo_filename, new Date()
      ]
    );

    res.json({
      success: true,
      message: "Contract user uploaded successfully!",
      uploadedUser: { uniqueID, name, photoFileName }
    });

  } catch (error) {
    console.error('Error saving contract user:', error);
    res.status(500).json({ error: 'An error occurred while saving the contract user' });
  }
});


// Verify if name already exists
app.post('/verify-name', (req, res) => {
  const { name } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const query = 'SELECT COUNT(*) AS count FROM users WHERE name = ?';
  connection.query(query, [name], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database query failed' });
    }

    const count = result[0].count;
    res.json({ exists: count > 0 });
  });
});




app.post('/upload-bulk-contract-users', upload.single('bulkUsersFile'), (req, res) => {
  if (!req.file) return res.status(400).send({ error: 'No file uploaded.' });

  const workbook = xlsx.readFile(req.file.path);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const usersData = xlsx.utils.sheet_to_json(sheet); // expects: name, dateOfJoining, mobileNo, Contract

  // Check database duplicates
  const namesInExcel = usersData.map(u => u.name);
  const query = `SELECT name FROM users WHERE name IN (?)`;
  connection.query(query, [namesInExcel], (err, results) => {
    if (err) return res.status(500).send({ error: 'DB error' });

    const existingNames = results.map(r => r.name);

    // Mark duplicates in Excel
    usersData.forEach(u => {
      if (existingNames.includes(u.name)) u.duplicateType = 'db';
      else u.duplicateType = 'none';
    });

    res.json({ users: usersData }); // frontend can show duplicates and let admin confirm
  });
});




app.post('/confirm-bulk-contract-users', express.json(), (req, res) => {
  const users = req.body.users.filter(u => u.duplicateType === 'none');

  if (!users.length) return res.send('No valid users to upload.');

  users.forEach(user => {
    const uniqueID = uuidv4();
    const query = `INSERT INTO users (name, dateOfJoining, mobileNo, Contract, uniqueID, currentDate) 
                   VALUES (?, ?, ?, ?, ?, ?)`;
    connection.query(query, [
      user.name, user.dateOfJoining, user.mobileNo, user.Contract,
      uniqueID, new Date()
    ], err => {
      if (err) console.error('Insert error:', err);
    });
  });

  res.send('Contract users uploaded successfully.');
});

// Add this new route to your main Express server file

app.post("/submitPosttestData", express.json(), (req, res) => {
    let { courseID, uniqueID, employeeID, name, score, duration, date, allAnswersJson } = req.body;

    // Sanitization
    uniqueID = uniqueID ? uniqueID.trim() : '';
    
    if (!courseID || !uniqueID || score === undefined) {
        console.error("Missing required data. uniqueID:", uniqueID);
        return res.status(400).send("Missing required submission data");
    }

    const courseTable = `course_${courseID}`;
    const status = score >= 40 ? 'passed' : 'failed'; // Adjust threshold as needed

    // Check if user exists in course table
    const checkEnrollmentQuery = `SELECT noOfAttempts FROM ${courseTable} WHERE uniqueID = ?`;
    
    connection.query(checkEnrollmentQuery, [uniqueID], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).send('Database error');
        }
        
        if (results.length === 0) {
            // ✅ USER NOT ENROLLED - Insert them first
            const insertQuery = `INSERT INTO ${courseTable} (uniqueID, employeeID, name, noOfAttempts) VALUES (?, ?, ?, 0)`;
            connection.query(insertQuery, [uniqueID, employeeID, name], (insertErr) => {
                if (insertErr) {
                    console.error('Error enrolling user:', insertErr);
                    return res.status(500).send('Error enrolling user in course');
                }
                // Now proceed with attempt update (use 1 as first attempt)
                updateAttemptData(1);
            });
        } else {
            // User exists, get current attempts
            const currentAttempts = results[0].noOfAttempts;
            const newAttempt = currentAttempts + 1;
            
            if (newAttempt > 27) {
                return res.status(400).send('Maximum attempts (27) reached');
            }
            
            updateAttemptData(newAttempt);
        }
        
        function updateAttemptData(attemptNum) {
            const updateCourseQuery = `
                UPDATE ${courseTable} 
                SET noOfAttempts = ?, 
                    course_${courseID}_Posttest${attemptNum} = ?, 
                    score${attemptNum} = ?, 
                    status${attemptNum} = ?, 
                    duration${attemptNum} = ?, 
                    date${attemptNum} = ?
                WHERE uniqueID = ?
            `;
            
            connection.query(updateCourseQuery, [attemptNum, allAnswersJson, score, status, duration, date, uniqueID], (err) => {
                if (err) {
                    console.error('Error updating course table:', err);
                    return res.status(500).send('Error updating course data');
                }

                // Update users table
                const updateUsersQuery = `
                    UPDATE users 
                    SET course${courseID}Posttest = ?, 
                        course${courseID}TrainDate = ?, 
                        uCourse${courseID} = ?
                    WHERE uniqueID = ?
                `;
                
                connection.query(updateUsersQuery, [score, date, name, uniqueID], (err2) => {
                    if (err2) {
                        console.error('Error updating users table:', err2);
                        return res.status(500).send('Error updating user data');
                    }

                    console.log(`✅ Posttest data saved successfully for attempt ${attemptNum}`);
                    res.status(200).send(`Posttest submitted successfully. Attempt: ${attemptNum}`);
                });
            });
        }
        
    });
});
// ============================================
// LEVEL CRITERIA ROUTES - Place these OUTSIDE other routes
// Add this section BEFORE app.listen() at the end of your file
// ============================================

const CRITERIA_FILE_PATH = path.join(__dirname, 'data', 'levelCriteria.json');

// Default criteria
const DEFAULT_CRITERIA = {
    L1: { min: 0, max: 85, result: 'FAIL', class: 'level-L1' },
    L2: { min: 86, max: 90, result: 'PASS', class: 'level-L2' },
    L3: { min: 91, max: 95, result: 'PASS', class: 'level-L3' },
    L4: { min: 96, max: 100, result: 'PASS', class: 'level-L4' }
};

// Ensure data directory exists
async function ensureDataDirectory() {
    const dataDir = path.join(__dirname, 'data');
    try {
        await fs.promises.access(dataDir);
    } catch {
        await fs.promises.mkdir(dataDir, { recursive: true });
    }
}

// GET endpoint to retrieve level criteria
app.get('/getLevelCriteria', async (req, res) => {
    try {
        await ensureDataDirectory();
        
        // Try to read existing criteria file
        try {
            const data = await fs.promises.readFile(CRITERIA_FILE_PATH, 'utf8');
            const criteria = JSON.parse(data);
            res.json({ success: true, criteria: criteria });
        } catch (error) {
            // If file doesn't exist, return default criteria
            if (error.code === 'ENOENT') {
                res.json({ success: true, criteria: DEFAULT_CRITERIA });
            } else {
                throw error;
            }
        }
    } catch (error) {
        console.error('Error reading level criteria:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error reading level criteria',
            criteria: DEFAULT_CRITERIA 
        });
    }
});

// POST endpoint to save level criteria
app.post('/saveLevelCriteria', async (req, res) => {
    try {
        const { criteria } = req.body;
        
        if (!criteria) {
            return res.status(400).json({ 
                success: false, 
                message: 'No criteria provided' 
            });
        }
        
        // Validate criteria structure
        const requiredLevels = ['L1', 'L2', 'L3', 'L4'];
        for (const level of requiredLevels) {
            if (!criteria[level] || 
                typeof criteria[level].min !== 'number' || 
                typeof criteria[level].max !== 'number') {
                return res.status(400).json({ 
                    success: false, 
                    message: `Invalid criteria structure for ${level}` 
                });
            }
        }
        
        await ensureDataDirectory();
        
        // Save criteria to file
        await fs.promises.writeFile(
            CRITERIA_FILE_PATH, 
            JSON.stringify(criteria, null, 2), 
            'utf8'
        );
        
        console.log('✅ Level criteria saved successfully');
        
        res.json({ 
            success: true, 
            message: 'Level criteria saved successfully',
            criteria: criteria 
        });
    } catch (error) {
        console.error('Error saving level criteria:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error saving level criteria' 
        });
    }
});

// Optional: Endpoint to reset criteria to default
app.post('/resetLevelCriteria', async (req, res) => {
    try {
        await ensureDataDirectory();
        
        await fs.promises.writeFile(
            CRITERIA_FILE_PATH, 
            JSON.stringify(DEFAULT_CRITERIA, null, 2), 
            'utf8'
        );
        
        res.json({ 
            success: true, 
            message: 'Level criteria reset to default',
            criteria: DEFAULT_CRITERIA 
        });
    } catch (error) {
        console.error('Error resetting level criteria:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error resetting level criteria' 
        });
    }
});

// ============================================
// Keep your app.listen() at the very end
// ============================================

app.listen(3230, () => {
  console.log('Server is running on port 3230');
});
