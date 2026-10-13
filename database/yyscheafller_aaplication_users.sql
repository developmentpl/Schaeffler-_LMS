-- MySQL dump 10.13  Distrib 8.0.33, for Win64 (x86_64)
--
-- Host: 192.168.31.150    Database: yyscheafller_aaplication
-- ------------------------------------------------------
-- Server version	8.0.33

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `uniqueID` int NOT NULL AUTO_INCREMENT,
  `name` text,
  `emailID` text,
  `employeeID` text,
  `uName` text,
  `uPass` text,
  `photo` text,
  `photoPath` text,
  `dateOfJoining` text,
  `dateOfBirth` text,
  `address` text,
  `mobileNo` text,
  `department` text,
  `uRole` text,
  `registerDate` text,
  `registerTime` text,
  `lastLoggedIn` text,
  `qualification` text,
  `contract` text,
  `contractorName` text,
  `status` text,
  `skillLevel` text,
  `rfid` text,
  `rfidIssueDate` text,
  `userTags` text,
  `remark` text,
  `batchNumber` int DEFAULT NULL,
  `batchDate` text,
  `catergory` text,
  `preExperience` text,
  `experiencefield` varchar(50) DEFAULT NULL,
  `ipcCertificate` text,
  `ipcCertifiedDate` date DEFAULT NULL,
  `jobCardIssue` varchar(45) DEFAULT NULL,
  `jobCardIssueDate` date DEFAULT NULL,
  `mahindraOldUserID` int DEFAULT NULL,
  `mahindraOldUniqueID` text,
  `licenseIssueDate` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`uniqueID`),
  KEY `idx_users_employee` (`employeeID`(50)),
  KEY `idx_users_uname` (`uName`(50))
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'Shubham Pande','','EMP012','shubham','1234','Shubham_Pande_01-07-2026_15-50_CERT.png','/photos/default.png','46076',NULL,'','','','Employee','27/06/2026','6:19:08 PM','2026-07-01 15:53:44.605','graduation','',NULL,NULL,'Level 1',NULL,NULL,'',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-06-30'),(2,'sumedh Shinde','','EMP013','sumedh','1234','default.png','/photos/default.png','46050',NULL,'','','','Employee','27/06/2026','6:19:08 PM','2026-07-01 19:34:49.194','graduation','',NULL,NULL,'Level 1',NULL,NULL,'',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-06-30'),(3,'Bhimashankar Wagalgave','developer@parallellearning.in','1','bhima','1234','Bhimashankar_Wagalgave_01-07-2026_15-49.png','/photos/Bhimashankar_Wagalgave_01-07-2026_15-49.png','2026-07-01','2002-12-31','pune','9055445455',NULL,'Technical Assistant','01/07/2026','3:49:40 PM','2026-07-02 10:09:10.418','master in computer Scince','2 year',NULL,NULL,'Level 1',NULL,NULL,'',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-02');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:34
