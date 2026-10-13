const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
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
}).replace(/\//g, '');

const currentTime = new Date().toLocaleTimeString('en-US', {
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
}).replace(/:/g, '');

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
  database: 'yyschaefflerr1',
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

// Serve home.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});



// Serve index.html for both root and "/courses" routes
app.get(['/courses'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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

//app.set('view engine', 'ejs');


//User information upload
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public/photos'),
  filename: (req, file, callback) => {
    const { name } = req.body;
    const sanitizedName = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
    const fileName = `${sanitizedName}_${currentDate}_${currentTime}.png`;
    callback(null, fileName);
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

app.post('/save-details', async (req, res) => {
  let { name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, Contract, uRole, courseTags, Qualification } = req.body;

  const uniqueID = uuidv4(); // Generate a unique ID

  const sanitizedName = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  const fileName = `${sanitizedName}_${currentDate}_${currentTime}.png`;
  const photo_filename = `C:/Users/saksh/OneDrive/Desktop/R8_Schaeffler LMS (25-03-2025 12.00 pm_Without course)/public/photos/${fileName}`; // Construct the photo path
  // const userID = <%= id %>;
  console.log(Qualification);
  const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
  const myCurrentTime = new Date().toLocaleTimeString('en-US', {});
  const userInfo = { uniqueID, employeeID, name }; // The data to insert into course tables

  try {
    // Step 1: Insert user data into the main user table
    await connection.promise().query(
      'INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, courseTags,Contract ,Qualification) VALUES (NULL, ?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)',
      [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, fileName, photo_filename, myCurrentDate, myCurrentTime, JSON.stringify(courseTags), Contract, Qualification]
    );

    // Step 2: Retrieve courseIDs from the courses table based on the selected tags
    const [courses] = await connection.promise().query(`
      SELECT courseID
      FROM courses
      WHERE ${courseTags.map(tag => `FIND_IN_SET(?, courseTags)`).join(' OR ')}`,
      courseTags
    );

    // Step 3: For each courseID, insert the user data into the respective course table
    for (let course of courses) {
      const courseTableName = `course_${course.courseID}`;
      await connection.promise().query(`INSERT INTO ${courseTableName} (uniqueID, employeeID, name) VALUES (?, ?, ?)`, [uniqueID, employeeID, name]);
    }
    res.sendStatus(200);

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

app.post('/save-photo', uploadMysql.single('photo'), (req, res) => {
  console.log('Photo uploaded successfully');
  res.sendStatus(200);
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
  let { name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, courseTags, Contract } = req.body;

  const uniqueID = uuidv4(); // Generate a unique ID

  const sanitizedName = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  const fileName = `${sanitizedName}_${currentDate}_${currentTime}.png`;
  const photo_filename = `D:/Parallel learning/Jsapp/LMS and ARS/R4_13-12-2024/R4_Tetrapak LMS (11-12-2024 8.15pm)/public/photos/${fileName}`; // Construct the photo path
  // const userID = <%= id %>;

  const myCurrentDate = new Date().toLocaleDateString('en-GB', {});
  const myCurrentTime = new Date().toLocaleTimeString('en-US', {});
  const userInfo = { uniqueID, employeeID, name }; // The data to insert into course tables

  try {
    // Step 1: Insert user data into the main user table
    await connection.promise().query(
      'INSERT INTO users (id, uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, photo, photo_filename, currentDate, currentTime, courseTags ,Contract ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, uRole, fileName, photo_filename, myCurrentDate, myCurrentTime, JSON.stringify(courseTags), Contract]
    );

    // Step 2: Retrieve courseIDs from the courses table based on the selected tags
    const [courses] = await connection.promise().query(`
      SELECT courseID
      FROM courses
      WHERE ${courseTags.map(tag => `FIND_IN_SET(?, courseTags)`).join(' OR ')}`,
      courseTags
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








// Route to fetch course tags
app.get('/get-course-tags', (req, res) => {
  const query = 'SELECT DISTINCT courseTags FROM courses';
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error fetching course tags:', error);
      res.status(500).json({ error: 'Internal server error' });
    } else {
      let tags = [];
      results.forEach(row => {
        if (row.courseTags) { // Check if courseTags is not null
          const rowTags = row.courseTags.split(',').map(tag => tag.trim());
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
  let { courseName, courseDescription, courseDate, courseID, courseTags } = req.body;

  // Set courseTags to "default" if it is not provided
  if (!courseTags || courseTags.trim() === '') {
    courseTags = 'default';
  }

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

          // Send JavaScript response to show alert message and redirect back to the upload page
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
    });
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
  const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;
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


// Get the course list on viewscorm page
app.get('/getViewscormCourseList', (req, res) => {
  const query = `SELECT id, courseName, courseDate, courseDescription, courseTeacher, scormPath, courseID FROM courses ORDER BY id DESC`;
  const uniqueID = req.session.user.uniqueID; // Get user's unique ID from session

  connection.query(query, (error, results) => {
    if (error) {
      console.error(error);
      return res.status(500).send('Internal Server Error');
    }

    // Filter courses where SCORM path exists
    const filteredResults = results.filter(course => {
      const scormFolderPath = path.join(__dirname, course.scormPath);
      return fs.existsSync(scormFolderPath);
    });

    // Fetch status for each course
    const statusQueries = filteredResults.map(course => {
      return new Promise((resolve, reject) => {
        const statusQuery = `SELECT status1, status2, status3 FROM course_${course.courseID} WHERE uniqueID = ?`;
        connection.query(statusQuery, [uniqueID], (err, statusResults) => {
          if (err) {
            console.error(err);
            resolve({ courseID: course.courseID, status: 'No Attempt' }); // Default if error occurs
          } else if (statusResults.length > 0) {
            // Check status values and determine last attempt
            const attempts = [];
            for (let i = 1; i <= 3; i++) {
              if (statusResults[0][`status${i}`]) {
                attempts.push(statusResults[0][`status${i}`]);
              }
            }
            resolve({ courseID: course.courseID, status: attempts.length ? attempts.join(', ') : 'No Attempt' });
          } else {
            resolve({ courseID: course.courseID, status: 'No Attempt' });
          }
        });
      });
    });

    Promise.all(statusQueries)
      .then(statusResults => {
        // Merge status with courses
        const finalResults = filteredResults.map(course => {
          const statusObj = statusResults.find(status => status.courseID === course.courseID);
          return { ...course, status: statusObj ? statusObj.status : 'No Attempt' };
        });

        res.json(finalResults);
      })
      .catch(error => {
        console.error(error);
        res.status(500).send('Error fetching status data');
      });
  });
});





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

// app.post('/update-data', (req, res) => {
//   const { uniqueID, LisenceIssue, Level } = req.body;

//   console.log("Received data:", { uniqueID, LisenceIssue, Level });
//   // const query = `UPDATE users SET LisenceIssueDate = ?, Level = ? WHERE uniqueID = ?`;
//   // connection.query(query, [LisenceIssue, Level, uniqueID], (updateError, results) => {


//   const query = `UPDATE users SET LisenceIssueDate = ? WHERE uniqueID = ?`;
//   connection.query(query, [LisenceIssue, uniqueID], (updateError, results) => {
//     if (updateError) {
//       console.error('Error updating database:', updateError);
//       return res.status(500).json({ success: false, message: 'Failed to update database' });
//     }
//     console.log('Database updated successfully');
//     return res.json({ success: true });
//   });
// });

app.post('/update-data', (req, res) => {
  const { name, uniqueID, LisenceIssue, Level } = req.body;

  console.log("Received data:", { name, uniqueID, LisenceIssue, Level });
  // const query = `UPDATE users SET LisenceIssueDate = ?, Level = ? WHERE uniqueID = ?`;
  // connection.query(query, [LisenceIssue, Level, uniqueID], (updateError, results) => {

  const sanitizedName = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  const fileName = `${sanitizedName}_${currentDate}_${currentTime}.png`;
  const photo_filename = `C:/Users/saksh/OneDrive/Desktop/R8_Schaeffler LMS (25-03-2025 12.00 pm_Without course)/public/photos/${fileName}`;

  const query = `UPDATE users SET LisenceIssueDate = ?, photo = ?, photo_filename = ?, Level = ? WHERE uniqueID = ?`;

  connection.query(query, [LisenceIssue, fileName, photo_filename, Level, uniqueID], (updateError, results) => {
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

//Route for retrieving user data from the database
// app.get('/userData', (req, res) => {
//   // Query to retrieve user data from the database
//   const query = 'SELECT name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, Contract, Qualification, uRole, currentDate FROM users'; // Adjust query based on your database schema
//   connection.query(query, (error, results) => {
//     if (error) {
//       console.error('Error retrieving user data:', error);
//       return res.status(500).send('Internal Server Error');
//     }
//     // Sending user data as JSON response
//     res.json(results);
//   });
// });

app.get('/userData', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 7;
  const offset = (page - 1) * limit;

  const countQuery = 'SELECT COUNT(*) as count FROM users';
  const dataQuery = `
    SELECT  uniqueID, name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, Contract, Qualification, uRole, currentDate
    FROM users
    LIMIT ? OFFSET ?`;

  connection.query(countQuery, (err, countResult) => {
    if (err) {
      console.error('Error counting users:', err);
      return res.status(500).send('Internal Server Error');
    }

    const total = countResult[0].count;

    connection.query(dataQuery, [limit, offset], (err, users) => {
      if (err) {
        console.error('Error retrieving paginated users:', err);
        return res.status(500).send('Internal Server Error');
      }

      res.json({
        users,
        total
      });
    });
  });
});



// test route
// app.get('/userData', (req, res) => {
//   const page = parseInt(req.query.page) || 1;
//   const limit = parseInt(req.query.limit) || 50;
//   const offset = (page - 1) * limit;

//   const usersQuery = `
//     SELECT uniqueID, name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, photo, dateOfJoining, department, uRole, currentDate, Contract
//     FROM users
//     LIMIT ?, ?
//   `;

//   const countQuery = `SELECT COUNT(*) as total FROM users`;

//   // Run first query
//   connection.query(usersQuery, [offset, limit], (err, usersResult) => {
//     if (err) {
//       console.error('Error fetching users:', err);
//       return res.status(500).json({ error: 'Error fetching users' });  // ✅ Return valid JSON error
//     }

//     // Run second query
//     connection.query(countQuery, (err2, countResult) => {
//       if (err2) {
//         console.error('Error fetching total:', err2);
//         return res.status(500).json({ error: 'Error counting users' }); // ✅ Return valid JSON error
//       }

//       const total = countResult[0].total;
//       return res.json({ users: usersResult, total });  // ✅ Return proper data
//     });
//   });
// });




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






// Route to fetch user grades based on employeeID
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
app.get('/getUserAttempts', (req, res) => {
  const courseID = req.query.courseID;
  const attemptNumber = req.query.attemptNumber;
  const employeeID = req.query.employeeID; // Pass this from the front-end if needed
  if (!courseID || !attemptNumber) {
    return res.status(400).json({ success: false, message: 'Course ID and attempt number are required.' });
  }

  /*const query = `SELECT noOfAttempts, 
                        course_${courseID}_Posttest${attemptNumber} AS posttest, 
                        score${attemptNumber} AS score, 
                        status${attemptNumber} AS status, 
                        duration${attemptNumber} AS duration 
                 FROM course_${courseID} 
                 WHERE employeeID = ?`;*/
  /*const query = `
  SELECT 
      noOfAttempts, course_${courseID}_Posttest${attemptNumber},
      score${attemptNumber}, status${attemptNumber}, duration${attemptNumber}
  FROM course_${courseID}
  WHERE employeeID = ?
`;*/
  const query = `
  SELECT 
      noOfAttempts,  
      course_${courseID}_Posttest${attemptNumber} AS posttest,
      score${attemptNumber} AS score, 
      status${attemptNumber} AS status, 
      duration${attemptNumber} AS duration
  FROM course_${courseID}
  WHERE employeeID = ?
`;


  connection.query(query, [employeeID], (error, results) => {
    if (error) {
      console.error('Error fetching attempt data:', error);
      console.error('courseID fail: ', courseID);
      console.error('attemptNumber fail: ', attemptNumber);
      console.error('employeeID fail: ', employeeID);
      return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
    if (results.length === 0) {
      console.error('courseID fail 2: ', courseID);
      console.error('attemptNumber fail 2: ', attemptNumber);
      console.error('employeeID fail 2: ', employeeID);
      return res.status(404).json({ success: false, message: 'No data found for this attempt.' });
    }
    console.error('courseID Pass 2: ', courseID);
    console.error('attemptNumber Pass 2: ', attemptNumber);
    console.error('results Pass 2: ', results);

    const attemptDetails_noOfAttempt = results[0].noOfAttempts;
    const attemptDetails_posttest = results[0].posttest;
    const attemptDetails_score = results[0].score;
    const attemptDetails_status = results[0].status;
    const attemptDetails_duration = results[0].duration;

    console.error('results Pass 3: ', results[0].noOfAttempts);

    res.json({ success: true, attemptData: results[0], attemptDetails_noOfAttempt: attemptDetails_noOfAttempt, attemptDetails_posttest: attemptDetails_posttest, attemptDetails_score: attemptDetails_score, attemptDetails_status: attemptDetails_status, attemptDetails_duration: attemptDetails_duration });
  });
});






// Route to delete a user from the database
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



// Update user's SCORM data
app.post('/updateUserSCORMData', (req, res) => {

  const { posttestScore, courseID, courseName } = req.body;
  const uniqueID = req.session.user.uniqueID;

  // // Use the currentCourseID global variable here
  // const query2 = `SELECT courseID FROM courses ORDER BY id DESC`;
  // Construct the column names dynamically based on the courseID
  const posttestColumn = `course${courseID}Posttest`;
  const courseNameColumn = `uCourse${courseID}`;
  console.log("uniqueID is: " + uniqueID);

  // Update the user's SCORM data in the database
  const query = `UPDATE users SET ${posttestColumn} = ?, ${courseNameColumn} = ? WHERE uniqueID = ?`;
  connection.query(query, [posttestScore, courseName, uniqueID], (error, results) => {
    if (error) {
      console.error('Error updating user SCORM data:', error);
      console.log("uniqueID is in error: " + uniqueID);
      return res.status(500).send('Internal Server Error');
    }
    console.log('User SCORM data updated successfully');
    console.log('Result ', posttestScore, courseName, uniqueID);
    res.sendStatus(200);
  });
});


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



// Update user's SCORM data
app.post('/updateUserSCORMDataInCourseTable', (req, res) => {
  const { posttestScore, Score, Status, duration, courseID } = req.body;
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

    // Update the user's SCORM data in the database
    const updateQuery = `
      UPDATE course_${courseID}
      SET ${posttestColumn} = ?, ${scoreColumn} = ?, ${statusColumn} = ?, ${durationColumn} = ?, noOfAttempts = ?
      WHERE uniqueID = ?
    `;

    connection.query(updateQuery, [posttestScore, Score, Status, duration, attempt, uniqueID], (error, results) => {
      if (error) {
        console.error('Error updating user SCORM data:', error);
        return res.status(500).send('Internal Server Error');
      }
      console.log('User SCORM data updated successfully for attempt', attempt);
      res.sendStatus(200);
    });
  });
});


// Update user's SCORM data
app.post('/updateUserEXCELDataInCourseTable', (req, res) => {
  const { localPosttest, localScore, localStatus, localduration, courseID } = req.body;
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

    // Update the user's SCORM data in the database
    const updateQuery = `
      UPDATE course_${courseID}
      SET ${posttestColumn} = ?, ${scoreColumn} = ?, ${statusColumn} = ?, ${durationColumn} = ?, noOfAttempts = ?
      WHERE uniqueID = ?
    `;

    connection.query(updateQuery, [localPosttest, localScore, localStatus, localduration, attempt, uniqueID], (error, results) => {
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

  const query = `SELECT courseName, courseDescription, courseDate, courseTags FROM courses WHERE courseID = ?`;
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
  // Query to retrieve user data from the database
  const query = 'SELECT uniqueID, name, employeeID, uName, dateOfJoining, department, currentDate FROM users'; // Adjust query based on your database schema
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving user data:', error);
      return res.status(500).send('Internal Server Error');
    }
    // Sending user data as JSON response
    res.json(results);
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
app.post('/upload-bulk-users', upload.single('bulkUsersFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }
  // const uniqueID = uuidv4();

  const workbook = xlsx.readFile(req.file.path);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const usersData = xlsx.utils.sheet_to_json(sheet);

  usersData.forEach(user => {
    let uniqueID = uuidv4();  // Move this inside the loop to generate a new unique ID for each user
    // Insert each user into the database
    // name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department,Contract, uRole, courseTags,Qualification
    const query = `INSERT INTO users (uniqueID, name, emailID, employeeID, uName, uPass, dateOfJoining, dateOfBirth, address, mobileNo, department, Contract, uRole, courseTags, currentDate, Qualification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    connection.query(query, [
      uniqueID,
      user.name, user.emailID, user.employeeID, user.uName,
      user.uPass, user.dateOfJoining, user.dateOfBirth,
      user.address, user.mobileNo, user.department, user.Contract, user.uRole, user.courseTags, user.currentDate, user.Qualification
    ], (error, results) => {
      if (error) {
        console.error('Error inserting user:', error);
      } else {
        console.log('User inserted successfully:', user.name);
      }
    });
  });
  console.log("Bluk users uploaded successfully");
  //res.send('Bulk users uploaded successfully.');
});


// // Route to handle saving changes
// app.post('/saveChanges', (req, res) => {
//   const updatedData = req.body;

//   // Loop through updated data and update corresponding records in the database
//   updatedData.forEach(data => {
//     // Construct the column name based on the courseID
//     const mysqlColumnName  = `uCourse${data.courseID}`;
//     // Assuming you have a function to update the database
//     updateDatabase(data.employeeID, data.columnName, mysqlColumnName , data.newValue);
//   });

//   // Send response
//   res.sendStatus(200);
// });

// function updateDatabase(employeeID, columnName, newValue) {
//   const query = `UPDATE users SET ${columnName} = ? WHERE employeeID = ?`;
//   connection.query(query, [newValue, employeeID], (error, results) => {
//     if (error) {
//       console.error('Error updating database:', error);
//     } else {
//       console.log('Database updated successfully');
//     }
//   });
// }

/*
// Route to handle saving changes
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
});*/




/*
//make chamges in above function for the fast updations (above is the original code in index.js today (16/07/2025) make following route for updation)
app.post('/saveChanges', async (req, res) => {
  const updates = req.body.updatedData;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'No data received' });
  }

  const connectionPromise = connection.promise();
  const updateTasks = [];

  try {
    for (const entry of updates) {
      const { employeeID, columnName, newValue } = entry;

      if (!employeeID || !columnName) continue;

      const query = `UPDATE users SET \`${columnName}\` = ? WHERE employeeID = ?`;
      updateTasks.push(connectionPromise.query(query, [newValue, employeeID]));
    }

    await Promise.all(updateTasks);
    res.status(200).json({ success: true, updated: updateTasks.length });
  } catch (error) {
    console.error('Batch update failed:', error);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});*/



app.post('/saveChanges', async (req, res) => {
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

            // Update the Posttest score (or other field)
            const query = `UPDATE users SET \`${columnName}\` = ? WHERE uniqueID = ?`;
            updateTasks.push(connectionPromise.query(query, [newValue, uniqueID]));

            // If the column is like "course3Posttest", update "uCourse3"
            const match = columnName.match(/^course(\d+)Posttest$/);
            if (match && courseName) {
                const courseNumber = match[1];
                const uCourseColumn = `uCourse${courseNumber}`;

                const updateUCourse = connectionPromise.query(
                    `UPDATE users SET \`${uCourseColumn}\` = ? WHERE uniqueID = ?`,
                    [courseName, uniqueID]
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
});







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
      connection.query(query, [data.newValue, data.uniqueID], (error, results) => {
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
  const query = 'SELECT courseID, courseName FROM courses'; // Assuming you have a table named 'courses' with columns 'courseID' and 'courseName'
  connection.query(query, (error, results) => {
    if (error) {
      console.error('Error retrieving course names:', error);
      return res.status(500).send('Internal Server Error');
    }

    // Extract course names from the database results
    const courseNames = results.map(row => ({ courseID: row.courseID, courseName: row.courseName }));

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
  let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;
  const filePath = req.file.path;

  const uploadPath = 'Excel Assessment/Assessment pages';

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

  // Read the HTML template
  const templatePath = path.join(__dirname, "public", "excelAss_Template.html");
  let template = fs.readFileSync(templatePath, "utf-8");

  // // Generate HTML content for MCQs
  // let htmlContent = `
  //   <h1>${courseName} (Course ID: ${courseID})</h1>
  //   <form id="quiz-form">
  // `;

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
app.post("/uploadTraining", uploadFiles, (req, res) => {

  console.log("Files received:", req.files);
  console.log("Body received:", req.body);

  let { courseID, courseName, courseDescription, courseDate, courseTags } = req.body;

  const mcqFile = req.files.mcqFile?.[0];
  const videoFile = req.files["videoFile"]?.[0];

  if (!mcqFile) {
    return res.status(400).send("MCQ file is missing!");
  }
  const mcqFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", `${Date.now()}_${mcqFile.originalname}`);
  const videoFilePath = videoFile
    // ? path.join(__dirname, "uploads", "Training Assessment", "Videos", `${Date.now()}_${videoFile.originalname}`)
    ? path.join(__dirname, "uploads", "Training Assessment", "Videos", `${courseID}_video.mp4`)
    : null;

  try {
    fs.writeFileSync(mcqFilePath, mcqFile.buffer);
    console.log(`MCQ file saved at: ${mcqFilePath}`);

    if (!fs.existsSync(mcqFilePath)) {
      throw new Error("MCQ file path is invalid!");
    }
    //const videoFile = req.files.videoFile[0];

    //const filePath = mcqFile.path;

    const uploadPath = 'uploads/Training Assessment/Posttest assessment/training pages';

    // Read the uploaded Excel file
    const workbook = xlsx.readFile(mcqFilePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Handle video file

    if (videoFile) {
      fs.writeFileSync(videoFilePath, videoFile.buffer);
      console.log(`Video file saved at: ${videoFilePath}`);
      const videoPath = path.join("uploads", "Training Assessment", "Videos");
      console.log(`Video saved at: ${videoPath}`);
    }
    // Parse the worksheet data into JSON
    const jsonData = xlsx.utils.sheet_to_json(worksheet);

    // Set courseTags to "default" if it is not provided
    if (!courseTags || courseTags.trim() === '') {
      courseTags = 'default';
    }

    // Read the HTML template
    const templatePath = path.join(__dirname, "public", "trainingAss_Template.html");
    let template = fs.readFileSync(templatePath, "utf-8");
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

            // Replace placeholders in the template
            const finalQuizHTML = template
              .replace(/{{courseName}}/g, courseName)
              .replace(/{{courseID}}/g, courseID)
              .replace(/{{quizQuestions}}/g, quizQuestions);

            // Save HTML file
            const htmlFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", "training pages", `${courseID}_quiz.html`);
            fs.writeFileSync(htmlFilePath, finalQuizHTML);

            // Send final response with HTML and JavaScript combined
            res.send(`
            <p>File uploaded and quiz generated successfully!</p>
            <a href="/">Upload another file</a> | 
            <a href="/training/${courseID}">View Quiz</a>
            <script>
              const uploadConfirmation = confirm('Course uploaded successfully.');
              if (uploadConfirmation) {
                  // <p>File uploaded and quiz generated successfully!</p>
                  // <a href="/createCourse">Upload another file</a> | 
                  // <a href="/training/${courseID}">View Quiz</a>
                  window.location.href = '/createCourse.html';
              }
            </script>
          `);
          });
        });
      });
    });
  }
  catch (err) {
    console.error("Error processing files:", err);
    res.status(500).send("Error processing uploaded files.");
  }


});


//some extra works for fastness






// Route to serve the generated HTML quiz page
app.get("/training/:courseID", (req, res) => {
  const htmlFilePath = path.join(__dirname, "uploads", "Training Assessment", "Posttest assessment", "training pages", `${req.params.courseID}_quiz.html`);
  if (fs.existsSync(htmlFilePath)) {
    res.sendFile(htmlFilePath);
  } else {
    res.status(404).send("Quiz not found.");
  }
});

///New Fetch the user details from Admin Side Start
app.get('/UserDataAd', (req, res) => {
  // Extract the username of the logged-in user from the session
  const uniqueID = req.query.uniqueID;

  // Query to retrieve user data for the logged-in user only
  const query = 'SELECT name, emailID, employeeID, uName, uPass, mobileNo, dateOfBirth, address, dateOfJoining, department, uRole, currentDate, photo FROM users WHERE uniqueID = ?';

  connection.query(query, [uniqueID], (error, results) => {
    if (error) {
      console.error('Error retrieving user data:', error);
      return res.status(500).send('Internal Server Error');
    }
    // Sending user data as JSON response
    res.json(results);
  });
});
//New Code for when user clicks on name then userdata.html open end here


//----------------------------------------------------------------------------------------------
//Function for search user from database (Vipul)


// 01-07-2025 New code to be pasted starts here
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

// 01-07-2025 New code to be pasted ends here
app.listen(3230, () => {
  console.log('Server is running on port 3230');
});
