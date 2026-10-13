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
-- Table structure for table `enrollstatus`
--

DROP TABLE IF EXISTS `enrollstatus`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `enrollstatus` (
  `enrollID` int NOT NULL AUTO_INCREMENT,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `enrollDate` text,
  `startDate` date DEFAULT NULL,
  `endDate` date DEFAULT NULL,
  `enrollStatus` text,
  `multiSkill` varchar(45) DEFAULT NULL,
  `activeTrainingStations` int DEFAULT NULL,
  `stationID` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`enrollID`),
  KEY `idx_enroll_user` (`uniqueID`),
  KEY `idx_enroll_hierarchy` (`deptID`,`areaID`,`mCourseID`,`coMCourseID`,`subCourseID`),
  CONSTRAINT `fk_enroll_user` FOREIGN KEY (`uniqueID`) REFERENCES `users` (`uniqueID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `enrollstatus`
--

LOCK TABLES `enrollstatus` WRITE;
/*!40000 ALTER TABLE `enrollstatus` DISABLE KEYS */;
INSERT INTO `enrollstatus` VALUES (1,2,1,1,1,NULL,NULL,'29/06/2026','2026-06-29',NULL,'Active',NULL,NULL,0),(2,2,1,1,1,NULL,NULL,'01/07/2026','2026-07-01',NULL,'Active',NULL,NULL,1),(3,3,1,1,1,NULL,NULL,'02/07/2026','2026-07-02',NULL,'Active',NULL,NULL,1);
/*!40000 ALTER TABLE `enrollstatus` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:32
