-- One-time local setup (run as MySQL root). Tables are created by `pnpm db:migrate`, not here.
--   docker exec -i some-mysql mysql -uroot -p < db/bootstrap.sql
-- The password below is for local development only; use a different one anywhere else.
CREATE DATABASE IF NOT EXISTS outbrief CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS outbrief_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'outbrief'@'%' IDENTIFIED BY 'outbrief_local';
GRANT ALL PRIVILEGES ON outbrief.* TO 'outbrief'@'%';
GRANT ALL PRIVILEGES ON outbrief_test.* TO 'outbrief'@'%';
FLUSH PRIVILEGES;
