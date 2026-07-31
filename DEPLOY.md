# gitd 部署文档

> **gitd** —— 基于 Vercel Serverless + PostgreSQL 的 GitHub 代码部署工具
>
> 本文档面向所有用户（包括零基础用户），按照步骤操作即可完成部署。

---

## 目录

1. [系统介绍](#1-系统介绍)
2. [服务器要求](#2-服务器要求)
3. [部署方式一：Vercel 部署（推荐）](#3-部署方式一vercel-部署推荐)
4. [部署方式二：传统服务器部署](#4-部署方式二传统服务器部署)
5. [数据库配置](#5-数据库配置)
6. [环境变量说明](#6-环境变量说明)
7. [首次安装向导](#7-首次安装向导)
8. [授权配置](#8-授权配置)
9. [GitHub OAuth 配置](#9-github-oauth-配置)
10. [常见问题](#10-常见问题faq)
11. [更新升级](#11-更新升级)

---

## 1. 系统介绍

### 1.1 gitd 是什么？

gitd 是一个 GitHub 代码部署工具，帮助开发者将 GitHub 仓库中的代码快速、安全地部署到服务器。它基于 **Vercel Serverless** 架构构建，使用 **PostgreSQL** 作为数据存储，能够以极低的运维成本稳定运行。

### 1.2 核心功能

| 功能模块 | 说明 |
|---------|------|
| 代码部署 | 一键将 GitHub 仓库代码部署到目标服务器，支持分支选择、构建命令配置 |
| 项目管理 | 集中管理多个部署项目，查看部署历史与状态 |
| GitHub 集成 | 通过 GitHub OAuth 授权，自动读取仓库列表与分支信息 |
| 部署日志 | 实时查看部署过程的完整日志，便于排查问题 |
| 用户认证 | 基于 JWT 的安全认证体系，支持管理员账号管理 |
| 授权管理 | 通过 ET Studio（gitd.cn）授权码体系激活系统 |
| 安装向导 | 首次访问 `/install` 页面，图形化引导完成初始化 |

### 1.3 技术栈

- **前端**：纯 HTML / CSS / JavaScript（无框架，轻量、加载快）
- **后端**：Node.js API（Vercel Serverless Functions）
- **数据库**：PostgreSQL（Vercel Postgres 或自建）
- **认证**：JWT + bcrypt（密码哈希）
- **集成**：GitHub API

### 1.4 适用场景

- 个人开发者需要将自己的 GitHub 项目部署到云服务器
- 小型团队需要一个轻量的代码部署管理平台
- 希望以最低成本（甚至免费）搭建自动化部署系统

---

## 2. 服务器要求

### 2.1 Vercel 部署方式（推荐）

如果你选择 Vercel 部署，**几乎不需要自己准备服务器**，Vercel 平台会提供运行环境。你只需要准备：

| 项目 | 要求 |
|------|------|
| GitHub 账号 | 用于 Fork 仓库并触发部署 |
| Vercel 账号 | 免费注册即可，[vercel.com](https://vercel.com) |
| PostgreSQL 数据库 | 可使用 Vercel Postgres（免费额度），或任意外部 PostgreSQL 服务 |
| GitHub OAuth App | 用于实现 GitHub 登录与仓库授权（见第 9 节） |
| ET Studio 授权码 | 从 [gitd.cn](https://gitd.cn) 获取（见第 8 节） |

### 2.2 传统服务器部署方式

如果你选择在自己的服务器上部署，需要准备以下环境：

#### 2.2.1 硬件要求

| 配置项 | 最低要求 | 推荐配置 |
|--------|---------|---------|
| CPU | 1 核 | 2 核及以上 |
| 内存 | 1 GB | 2 GB 及以上 |
| 磁盘 | 10 GB | 20 GB 及以上 |
| 带宽 | 1 Mbps | 5 Mbps 及以上 |

#### 2.2.2 软件要求

| 软件 | 版本要求 | 说明 |
|------|---------|------|
| 操作系统 | Ubuntu 20.04+ / CentOS 7+ / Debian 10+ | 推荐 Ubuntu 22.04 LTS |
| Node.js | **22.x**（必须） | gitd 要求 Node.js 22，低版本会报错 |
| PostgreSQL | 14 及以上 | 数据库服务 |
| Nginx | 1.18 及以上 | 反向代理与 HTTPS |
| PM2 | 最新版 | Node.js 进程守护 |
| Git | 2.x | 拉取代码 |

#### 2.2.3 Node.js 22 安装示例（Ubuntu）

```bash
# 安装 NodeSource 源（Node.js 22）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# 安装 Node.js（包含 npm）
sudo apt-get install -y nodejs

# 验证版本
node -v   # 应输出 v22.x.x
npm -v    # 应输出 10.x.x
```

#### 2.2.4 PM2 安装

```bash
# 全局安装 PM2
sudo npm install -g pm2

# 设置开机自启
pm2 startup
pm2 save
```

#### 2.2.5 Nginx 安装

```bash
sudo apt-get update
sudo apt-get install -y nginx
```

#### 2.2.6 PostgreSQL 安装

```bash
# 安装 PostgreSQL 14
sudo apt-get install -y postgresql postgresql-contrib

# 启动并设置开机自启
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

---

## 3. 部署方式一：Vercel 部署（推荐）

这是最简单、最快的部署方式，全程在浏览器中操作，无需登录服务器。

### 3.1 第一步：Fork 仓库

1. 登录你的 GitHub 账号
2. 访问 gitd 的官方仓库页面（由项目方提供地址）
3. 点击页面右上角的 **Fork** 按钮
4. 在弹出的窗口中，选择你的账号作为 Fork 目标，点击 **Create fork**
5. 现在你的 GitHub 账号下已经有了一个 gitd 仓库副本

### 3.2 第二步：注册并登录 Vercel

1. 打开 [https://vercel.com](https://vercel.com)
2. 点击右上角 **Sign Up**（注册）
3. 选择 **Continue with GitHub**，使用 GitHub 账号登录
4. 授权 Vercel 访问你的 GitHub 账号
5. 完成注册后，进入 Vercel 控制台

### 3.3 第三步：创建 Vercel Postgres 数据库

1. 在 Vercel 控制台顶部导航栏，点击 **Storage**（存储）
2. 点击 **Create Database**（创建数据库）
3. 选择 **Postgres**（Vercel Postgres）
4. 输入数据库名称，例如 `gitd-db`
5. 选择离你最近的区域（Region），点击 **Create**
6. 创建完成后，进入数据库详情页，点击 **Connect to Project**（连接到项目）
7. 在弹出窗口中选择你将要创建的 gitd 项目（如果项目还未创建，可先跳过，稍后连接）
8. 此时系统会自动生成数据库连接字符串，你可以在 **Variables**（变量）标签页查看

> 数据库连接字符串格式类似：
> `postgres://user:password@host:port/dbname`

### 3.4 第四步：导入项目到 Vercel

1. 在 Vercel 控制台点击 **Add New**（新建）→ **Project**（项目）
2. 在 **Import Git Repository** 页面，找到你 Fork 的 gitd 仓库
3. 点击仓库右侧的 **Import**（导入）
4. 在项目配置页面：
   - **Framework Preset**：选择 `Other`（其他）或保持默认
   - **Root Directory**：保持默认（项目根目录）
   - **Build Command**：保持默认（或按仓库配置）
   - **Output Directory**：保持默认
5. **先不要点击 Deploy**，我们需要先配置环境变量（见下一步）

### 3.5 第五步：配置环境变量

在项目导入页面的 **Environment Variables**（环境变量）区域，逐个添加以下变量：

| Key（变量名） | Value（值） | 说明 |
|---------------|-------------|------|
| `POSTGRES_URL` | 你的 PostgreSQL 连接字符串 | 从 Vercel Postgres 的 Variables 标签页复制（如果已通过 Connect to Project 连接，Vercel 会自动注入，可跳过） |
| `DATABASE_URL` | 同 `POSTGRES_URL` | 与 `POSTGRES_URL` 保持一致 |
| `JWT_SECRET` | 一串随机字符串 | JWT 签名密钥，建议 32 位以上随机字符 |
| `GITHUB_OAUTH_CLIENT_ID` | 你的 GitHub OAuth App 的 Client ID | 见第 9 节获取方式 |
| `GITHUB_OAUTH_CLIENT_SECRET` | 你的 GitHub OAuth App 的 Client Secret | 见第 9 节获取方式 |
| `LICENSE_KEY` | 你的 ET Studio 授权码 | 从 [gitd.cn](https://gitd.cn) 获取 |
| `LICENSE_VERIFY_URL` | `https://gitd.cn/api/license/verify` | 授权验证地址（默认值，一般无需修改） |

> **生成 JWT_SECRET 的小技巧**：
> 你可以在终端运行以下命令生成一个随机字符串：
> ```bash
> openssl rand -hex 32
> ```
> 或使用在线随机字符串生成工具。

添加完成后，点击 **Deploy**（部署）按钮。

### 3.6 第六步：等待部署完成

1. Vercel 会自动开始构建和部署
2. 整个过程通常需要 1-3 分钟
3. 当看到 **Congratulations**（恭喜）页面时，表示部署成功
4. Vercel 会为你分配一个域名，类似 `gitd-xxxx.vercel.app`
5. 点击该域名，确认页面能正常打开

### 3.7 第七步：绑定自定义域名（可选）

如果你想使用自己的域名（例如 `gitd.yourdomain.com`）：

1. 在 Vercel 项目页面，点击 **Settings**（设置）→ **Domains**（域名）
2. 输入你的域名，点击 **Add**（添加）
3. 按照提示，到你的域名注册商处添加相应的 DNS 解析记录（通常是 CNAME 记录，指向 `cname.vercel-dns.com`）
4. 等待 DNS 生效（通常几分钟到几小时）
5. 生效后 Vercel 会自动为该域名配置 HTTPS 证书

### 3.8 第八步：完成首次安装

部署成功后，访问你的域名，根据第 7 节的「首次安装向导」完成系统初始化。

---

## 4. 部署方式二：传统服务器部署

如果你有自己的服务器，或希望完全掌控系统，可以选择传统部署方式。

### 4.1 第一步：安装基础环境

按照第 2.2 节的要求，安装好 Node.js 22、PM2、Nginx、PostgreSQL。

### 4.2 第二步：拉取代码

```bash
# 进入目标目录
cd /var/www

# 克隆 gitd 仓库
git clone https://github.com/你的用户名/gitd.git

# 进入项目目录
cd gitd
```

### 4.3 第三步：安装依赖

```bash
# 安装项目依赖
npm install

# 如果项目使用 pnpm 或 yarn，请对应使用：
# pnpm install
# yarn install
```

### 4.4 第四步：配置环境变量

在项目根目录创建 `.env` 文件：

```bash
nano .env
```

写入以下内容（根据你的实际情况修改）：

```env
# 数据库连接（请替换为你的实际连接字符串）
POSTGRES_URL=postgres://用户名:密码@127.0.0.1:5432/gitd
DATABASE_URL=postgres://用户名:密码@127.0.0.1:5432/gitd

# JWT 密钥（请替换为随机字符串）
JWT_SECRET=请替换为一串32位以上的随机字符串

# GitHub OAuth 配置（见第 9 节）
GITHUB_OAUTH_CLIENT_ID=你的GitHub_OAuth_Client_ID
GITHUB_OAUTH_CLIENT_SECRET=你的GitHub_OAuth_Client_Secret

# 授权配置（见第 8 节）
LICENSE_KEY=你的ET_Studio授权码
LICENSE_VERIFY_URL=https://gitd.cn/api/license/verify
```

保存并退出（nano 编辑器：按 `Ctrl + O` 保存，`Enter` 确认，`Ctrl + X` 退出）。

### 4.5 第五步：配置 Nginx 反向代理

创建 Nginx 配置文件：

```bash
sudo nano /etc/nginx/conf.d/gitd.conf
```

写入以下内容（将 `your-domain.com` 替换为你的域名，`3000` 替换为实际端口）：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 日志
    access_log /var/log/nginx/gitd_access.log;
    error_log  /var/log/nginx/gitd_error.log;

    # 前端静态文件
    location / {
        root /var/www/gitd/public;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # API 接口反向代理
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # 文件上传大小限制
    client_max_body_size 50m;
}
```

测试并重启 Nginx：

```bash
# 测试配置是否正确
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx
```

### 4.6 第六步：配置 HTTPS（强烈推荐）

使用 Let's Encrypt 免费证书配置 HTTPS：

```bash
# 安装 Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 申请并自动配置 HTTPS 证书
sudo certbot --nginx -d your-domain.com

# 按照提示操作，选择将 HTTP 重定向到 HTTPS
```

证书会自动续期，无需手动管理。

### 4.7 第七步：使用 PM2 启动服务

```bash
# 进入项目目录
cd /var/www/gitd

# 使用 PM2 启动应用（请根据项目实际入口文件调整）
pm2 start index.js --name gitd

# 保存进程列表（开机自启）
pm2 save

# 查看运行状态
pm2 status

# 查看日志
pm2 logs gitd
```

> 如果项目的启动命令不是 `node index.js`，请参考仓库根目录的 `package.json` 中的 `start` 脚本，例如：
> ```bash
> pm2 start "npm start" --name gitd
> ```

### 4.8 第八步：放行防火墙端口

```bash
# 放行 80 和 443 端口
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 如果使用了云服务器，还需在云服务商控制台的安全组中放行 80 和 443 端口
```

### 4.9 第九步：完成首次安装

访问你的域名，根据第 7 节完成系统初始化。

---

## 5. 数据库配置

### 5.1 方式一：使用 Vercel Postgres（推荐，配合 Vercel 部署）

1. 在 Vercel 控制台进入 **Storage**
2. 点击 **Create Database** → 选择 **Postgres**
3. 输入数据库名称，选择区域，点击 **Create**
4. 创建完成后，在数据库详情页查看 **Variables** 标签页
5. 你会看到 `POSTGRES_URL`、`DATABASE_URL` 等环境变量，复制它们的值
6. 如果已将数据库连接到项目，Vercel 会自动注入这些变量，无需手动添加

### 5.2 方式二：使用外部 PostgreSQL 服务

你可以使用任何支持 PostgreSQL 的云数据库服务，例如：

- **Supabase**（[supabase.com](https://supabase.com)，有免费额度）
- **Neon**（[neon.tech](https://neon.tech)，有免费额度）
- **Railway**（[railway.app](https://railway.app)）
- **阿里云 RDS PostgreSQL**
- **腾讯云 PostgreSQL**

注册并创建数据库后，服务商都会提供一个连接字符串，格式类似：

```
postgres://用户名:密码@主机地址:端口/数据库名
```

将该字符串填入 `POSTGRES_URL` 和 `DATABASE_URL` 环境变量即可。

### 5.3 方式三：自建 PostgreSQL 数据库（配合传统服务器部署）

#### 5.3.1 创建数据库和用户

```bash
# 切换到 postgres 用户
sudo -u postgres psql

# 在 PostgreSQL 命令行中执行以下命令：

# 创建数据库用户（请替换密码为强密码）
CREATE USER gitd_user WITH PASSWORD '你的强密码';

# 创建数据库
CREATE DATABASE gitd OWNER gitd_user;

# 授予全部权限
GRANT ALL PRIVILEGES ON DATABASE gitd TO gitd_user;

# 退出
\q
```

#### 5.3.2 获取连接字符串

连接字符串格式为：

```
postgres://gitd_user:你的强密码@127.0.0.1:5432/gitd
```

> 如果密码中包含特殊字符（如 `@`、`#`、`/` 等），需要进行 URL 编码，否则可能导致连接失败。

#### 5.3.3 配置远程访问（可选）

如果数据库和应用不在同一台服务器，需要允许远程连接：

```bash
# 编辑 PostgreSQL 配置文件
sudo nano /etc/postgresql/14/main/postgresql.conf

# 找到 listen_addresses，修改为：
listen_addresses = '*'

# 编辑访问控制文件
sudo nano /etc/postgresql/14/main/pg_hba.conf

# 在文件末尾添加：
host    all    all    0.0.0.0/0    md5

# 重启 PostgreSQL
sudo systemctl restart postgresql
```

> 出于安全考虑，建议将 `0.0.0.0/0` 替换为应用服务器的具体 IP 地址。

### 5.4 验证数据库连接

部署完成后，访问 `/install` 安装向导，系统会自动检测数据库连接状态。如果显示连接成功，说明配置正确。

---

## 6. 环境变量说明

以下是 gitd 运行所需的全部环境变量。**所有变量都是必填的**，缺少任何一个都可能导致系统无法正常工作。

| 变量名 | 是否必填 | 默认值 | 作用说明 |
|--------|---------|--------|---------|
| `POSTGRES_URL` | 是 | 无 | PostgreSQL 数据库连接字符串，格式为 `postgres://用户名:密码@主机:端口/数据库名`。系统通过此连接访问数据库。 |
| `DATABASE_URL` | 是 | 无 | 与 `POSTGRES_URL` 相同的数据库连接字符串。部分 ORM（如 Prisma）使用此变量名，为兼容性而设置。建议与 `POSTGRES_URL` 保持一致。 |
| `JWT_SECRET` | 是 | 无 | JWT（JSON Web Token）的签名密钥。用于签发和验证用户登录令牌，保证身份认证安全。**请务必设置为足够复杂的随机字符串（建议 32 位以上）**，泄露后他人可伪造登录。 |
| `GITHUB_OAUTH_CLIENT_ID` | 是 | 无 | GitHub OAuth App 的客户端 ID。用于实现 GitHub 登录与仓库授权。获取方式见第 9 节。 |
| `GITHUB_OAUTH_CLIENT_SECRET` | 是 | 无 | GitHub OAuth App 的客户端密钥。与 Client ID 配对使用，**请妥善保管，切勿泄露**。获取方式见第 9 节。 |
| `LICENSE_KEY` | 是 | 无 | ET Studio（gitd.cn）授权码。用于激活 gitd 系统，未配置或无效时系统将无法使用。获取方式见第 8 节。 |
| `LICENSE_VERIFY_URL` | 否 | `https://gitd.cn/api/license/verify` | 授权码验证接口地址。系统会向此地址发送请求验证授权码有效性。一般无需修改，除非使用私有授权服务器。 |

### 6.1 环境变量配置示例

#### Vercel 部署

在 Vercel 项目设置的 **Environment Variables** 页面逐个添加，或在 `vercel.json` 中引用。

#### 传统服务器部署

在项目根目录创建 `.env` 文件：

```env
POSTGRES_URL=postgres://gitd_user:YourPassword123@127.0.0.1:5432/gitd
DATABASE_URL=postgres://gitd_user:YourPassword123@127.0.0.1:5432/gitd
JWT_SECRET=a1b2c3d4e5f6789012345abcdef6789012345abcdef6789012345abcdef67890
GITHUB_OAUTH_CLIENT_ID=Iv1.abcdef1234567890
GITHUB_OAUTH_CLIENT_SECRET=abcdef1234567890abcdef1234567890abcdef12
LICENSE_KEY=YOUR-LICENSE-KEY-HERE
LICENSE_VERIFY_URL=https://gitd.cn/api/license/verify
```

> `.env` 文件包含敏感信息，请确保它已被 `.gitignore` 忽略，不要提交到代码仓库。

### 6.2 修改环境变量后

- **Vercel 部署**：修改环境变量后，需要重新部署项目才会生效（在 Deployments 页面点击 Redeploy）
- **传统服务器部署**：修改 `.env` 后，需要重启 PM2 进程：`pm2 restart gitd`

---

## 7. 首次安装向导

部署完成后，系统尚未初始化，数据库中没有数据表，也没有管理员账号。你需要通过安装向导完成初始化。**这是最简单的初始化方式，全程图形化操作，无需命令行。**

### 7.1 访问安装向导

1. 部署成功后，在浏览器中打开你的域名，并在后面加上 `/install`
   - 例如：`https://gitd-xxxx.vercel.app/install`
   - 或：`https://gitd.yourdomain.com/install`
2. 你会看到 gitd 安装向导页面，顶部有步骤进度指示器

### 7.2 安装向导步骤

安装向导共有 5 个步骤，按顺序操作即可：

#### 步骤一：环境检测

- 系统自动检测以下项目：
  - **数据库环境变量**：检查是否已配置 `POSTGRES_URL` / `DATABASE_URL`
  - **数据库连接**：尝试连接数据库
  - **JWT 密钥**：检查是否已配置 `JWT_SECRET`
- 全部通过后点击「下一步」继续
- 如果数据库未通过，仍可继续（在下一步手动输入连接字符串）

#### 步骤二：数据库配置

- 如果环境变量中已配置数据库连接字符串，直接点击「测试连接」
- 如果未配置，在输入框中填入数据库连接字符串：
  ```
  postgres://用户名:密码@主机:端口/数据库名
  ```
- 点击「测试连接」，显示绿色提示表示连接成功
- 连接成功后点击「初始化数据库」按钮
- 系统自动创建所有数据表（用户表、仓库表、历史记录表、设置表等）
- 初始化完成后自动进入下一步

#### 步骤三：创建管理员账号

- 输入管理员信息：
  - **用户名**：建议使用英文，例如 `admin`（默认已填）
  - **密码**：至少 8 位，建议包含字母和数字
  - **确认密码**：再次输入密码
- 点击「创建账号」
- 密码通过 bcrypt 加密后安全存储
- 管理员同时拥有前台用户权限（企业版套餐）

#### 步骤四：授权配置

- 输入从 [gitd.cn](https://gitd.cn) 获取的授权码
- 点击「保存并继续」
- 如果暂时没有授权码，点击「跳过」可稍后在后台配置
- **未配置授权码的系统将显示未授权提示横幅**，但不影响管理员使用

#### 步骤五：完成

- 点击「进入系统」按钮
- 系统自动跳转到登录页面
- 使用刚才创建的管理员账号登录
- 登录成功后即可使用全部功能

### 7.3 安装向导安全说明

- 安装完成后，`/install` 页面会显示「系统已安装」提示
- 如需重新安装，需手动清空数据库中 `settings` 表的 `install_completed` 记录
- 管理员账号创建后请妥善保管密码
- 系统内置防篡改保护，安装后关键文件被修改将触发保护机制

---

## 8. 授权配置

gitd 使用 ET Studio（[gitd.cn](https://gitd.cn)）的授权码体系进行授权验证。

### 8.1 获取授权码

1. 访问 [https://gitd.cn](https://gitd.cn)
2. 注册账号并登录
3. 在产品页面找到 **gitd** 授权购买入口
4. 根据需要选择授权类型（个人版/团队版等），完成购买
5. 购买成功后，在「我的授权」或「订单管理」页面查看你的授权码（License Key）
6. 授权码格式通常类似：`GS-XXXX-XXXX-XXXX-XXXX`

### 8.2 配置授权码

有两种方式配置授权码：

#### 方式一：通过环境变量配置（推荐）

将授权码配置在环境变量 `LICENSE_KEY` 中：

- **Vercel 部署**：在项目的 Environment Variables 中设置 `LICENSE_KEY`，然后重新部署
- **传统服务器部署**：在 `.env` 文件中设置 `LICENSE_KEY=你的授权码`，然后执行 `pm2 restart gitd`

#### 方式二：通过安装向导配置

在首次安装向导的「步骤四：配置授权码」中输入授权码（见第 7 节）。

#### 方式三：通过后台配置

完成安装并登录系统后：

1. 进入后台管理页面
2. 找到「系统设置」或「授权管理」菜单
3. 在授权码输入框中填入你的授权码
4. 点击「保存」或「验证授权」
5. 系统会调用验证接口确认授权码有效性

### 8.3 授权验证机制

- 系统会通过 `LICENSE_VERIFY_URL`（默认 `https://gitd.cn/api/license/verify`）验证授权码
- 验证过程需要服务器能正常访问 `gitd.cn`
- 如果验证接口不可达，请检查服务器的网络出站访问（特别是国内服务器访问境外地址，或境外服务器访问国内地址的网络情况）

### 8.4 授权保护系统

gitd 内置多层授权保护机制，确保系统不被未授权使用：

| 保护层 | 说明 |
|--------|------|
| 远程验证 | 每次请求都向 gitd.cn 验证授权码有效性（带 24 小时缓存） |
| 域名绑定 | 授权码绑定到部署域名，转移到其他域名将失效 |
| 代码完整性校验 | 关键文件被修改后系统自动检测并拒绝服务 |
| HMAC 签名验证 | 授权验证结果使用 HMAC 签名，防止中间人篡改 |
| 离线宽限 | 网络不可达时允许 48 小时离线运行（使用缓存授权） |
| 防篡改保护 | 关键模块（auth、license-verifier、protection）受完整性校验保护 |

- 未配置授权码时，系统仍可运行但会显示未授权提示横幅
- 管理员账号始终豁免授权检查，确保后台可访问
- 如需更换授权码，在后台「授权管理」中直接修改即可

### 8.5 授权常见问题

- **授权码无效**：检查是否复制完整，有无多余空格
- **授权码已过期**：联系 [gitd.cn](https://gitd.cn) 客服续期
- **验证接口无法访问**：检查服务器网络，或确认 `LICENSE_VERIFY_URL` 配置是否正确
- **更换授权码**：直接修改环境变量或后台设置中的授权码，保存即可
- **域名不匹配**：授权码绑定到首次激活的域名，更换域名需重新获取授权

---

## 9. GitHub OAuth 配置

gitd 通过 GitHub OAuth 实现与 GitHub 的集成，用于读取用户的仓库列表和分支信息。你需要创建一个 GitHub OAuth App。

### 9.1 创建 GitHub OAuth App

1. 登录 GitHub，访问 [https://github.com/settings/developers](https://github.com/settings/developers)
2. 点击左侧菜单的 **OAuth Apps**（OAuth 应用）
3. 点击右上角 **New OAuth App**（新建 OAuth 应用）
4. 填写应用信息：

   | 字段 | 填写内容 | 说明 |
   |------|---------|------|
   | **Application name**（应用名称） | `gitd` 或你喜欢的名字 | 显示在 GitHub 授权页面的应用名 |
   | **Homepage URL**（主页地址） | `https://你的域名` | 例如 `https://gitd.example.com` |
   | **Application description**（应用描述） | `GitHub 代码部署工具`（选填） | 应用简介 |
   | **Authorization callback URL**（回调地址） | `https://你的域名/api/auth/github/callback` | GitHub 授权完成后的回调地址，**必须完全一致** |

5. 填写完成后，点击 **Register application**（注册应用）

### 9.2 获取 Client ID 和 Client Secret

1. 注册完成后，页面会跳转到应用详情页
2. 你可以看到 **Client ID**（客户端 ID），直接复制保存
3. 点击 **Client Secret** 旁边的 **Generate a new client secret**（生成新的客户端密钥）
4. 在弹出的确认框中输入你的 GitHub 密码确认
5. 生成的 **Client Secret** 会显示出来，**立即复制保存**（离开页面后将无法再次查看完整内容）

> Client Secret 只在生成时完整显示一次，请务必妥善保存。如果遗失，可以重新生成（旧的会失效）。

### 9.3 配置到 gitd

将获取的 Client ID 和 Client Secret 配置到环境变量：

- `GITHUB_OAUTH_CLIENT_ID` = 你的 Client ID
- `GITHUB_OAUTH_CLIENT_SECRET` = 你的 Client Secret

配置方式参考第 6 节。

### 9.4 配置 OAuth 权限范围

创建 OAuth App 时，系统会根据所需权限请求以下范围（Scope）：

- `repo`：访问仓库（私有仓库需要）
- `read:org`：读取组织信息（如需部署组织仓库）

这些权限会在用户首次授权时显示在 GitHub 授权页面，用户确认后生效。

### 9.5 GitHub App 与 OAuth App 的区别

- **OAuth App**：以你的 OAuth App 身份访问用户数据，适合大多数场景（gitd 使用此方式）
- **GitHub App**：功能更强大，可安装在特定仓库，权限更精细

gitd 使用 OAuth App 即可满足需求。

### 9.6 修改回调地址

如果你后续更换了域名，需要同步更新 OAuth App 的 **Authorization callback URL**：

1. 访问 [https://github.com/settings/developers](https://github.com/settings/developers)
2. 点击你的 gitd OAuth App
3. 修改 **Authorization callback URL** 为新域名对应的回调地址
4. 点击 **Update application**（更新应用）保存

---

## 10. 常见问题（FAQ）

### Q1：访问域名显示空白页面或 502 错误

**可能原因与解决：**

- **Vercel 部署**：检查部署日志（Deployments → 点击对应部署 → Build Logs），查看是否有构建错误
- **传统服务器部署**：
  - 检查 PM2 进程是否正常运行：`pm2 status`
  - 查看应用日志：`pm2 logs gitd`
  - 检查 Nginx 配置是否正确：`sudo nginx -t`
  - 确认应用监听的端口与 Nginx 反向代理的端口一致

### Q2：安装向导提示「数据库连接失败」

**解决步骤：**

1. 检查 `POSTGRES_URL` / `DATABASE_URL` 环境变量是否配置正确
2. 确认连接字符串格式：`postgres://用户名:密码@主机:端口/数据库名`
3. 如果密码含特殊字符（`@`、`#`、`/`、`:`等），需进行 URL 编码：
   - `@` → `%40`
   - `#` → `%23`
   - `/` → `%2F`
   - `:` → `%3A`
4. 确认数据库服务正在运行：`sudo systemctl status postgresql`
5. 确认网络连通性：`telnet 数据库主机 端口`
6. 检查防火墙/安全组是否放行数据库端口（默认 5432）

### Q3：授权码验证失败

**解决步骤：**

1. 确认授权码输入完整，无多余空格
2. 确认 `LICENSE_KEY` 环境变量配置正确
3. 确认 `LICENSE_VERIFY_URL` 为 `https://gitd.cn/api/license/verify`
4. 确认服务器能访问 `gitd.cn`：
   ```bash
   curl https://gitd.cn/api/license/verify
   ```
5. 如果授权码已过期，联系 [gitd.cn](https://gitd.cn) 续期

### Q4：GitHub 登录失败，提示 redirect_uri_mismatch

**原因**：OAuth App 的回调地址与实际请求地址不一致。

**解决**：

1. 访问 [https://github.com/settings/developers](https://github.com/settings/developers)
2. 编辑你的 OAuth App
3. 将 **Authorization callback URL** 设置为 `https://你的域名/api/auth/github/callback`
4. 注意：必须使用 HTTPS（如果使用 HTTP 也需对应），域名和路径必须完全一致

### Q5：忘记管理员密码怎么办

**解决方法**：

- 如果你还能登录后台，在「用户管理」或「个人设置」中修改密码
- 如果无法登录，可通过数据库直接操作（需技术人员协助）：
  ```sql
  -- 连接数据库后执行（将密码重置为临时密码，再登录修改）
  -- 注意：以下示例需根据实际表结构调整
  UPDATE users SET password = '新的bcrypt哈希值' WHERE username = 'admin';
  ```
- 或重新运行安装向导（需先清空数据库数据表）

### Q6：Node.js 版本不对导致报错

**原因**：gitd 要求 Node.js 22，低版本会报错。

**解决**：

```bash
# 查看当前版本
node -v

# 如果不是 22.x，请重新安装（见第 2.2.3 节）
# 安装后重启 PM2
pm2 restart gitd
```

### Q7：Vercel 部署后环境变量不生效

**解决**：

- 修改环境变量后，必须**重新部署**才会生效
- 在 Vercel 控制台：Deployments → 找到最新部署 → 右侧菜单 → **Redeploy**
- 或推送一次代码到 GitHub 仓库触发自动部署

### Q8：部署后页面能打开，但功能不正常（API 报错）

**排查步骤**：

1. 打开浏览器开发者工具（F12）→ Network（网络）标签
2. 操作触发 API 请求，查看请求的响应状态码和内容
3. 常见情况：
   - **500 错误**：服务器内部错误，查看后端日志
   - **401 错误**：未登录或 JWT 过期，重新登录
   - **403 错误**：授权码无效或权限不足
   - **404 错误**：API 路径错误，检查 Nginx 反向代理配置

### Q9：如何查看系统日志

- **Vercel 部署**：Vercel 控制台 → 项目 → Logs（运行日志）或 Deployments → Build Logs（构建日志）
- **传统服务器部署**：`pm2 logs gitd`（实时查看），或查看 `/var/log/nginx/gitd_error.log`（Nginx 日志）

### Q10：能否部署到内网/离线环境

- Vercel 部署需要联网
- 传统服务器部署可以用于内网，但需要注意：
  - GitHub OAuth 需要能访问 GitHub
  - 授权码验证需要能访问 `gitd.cn`
  - 如果完全离线，GitHub 集成和授权验证功能将无法使用

### Q11：部署速度慢或经常超时

**可能原因**：

- 服务器配置过低
- 网络带宽不足
- 数据库连接慢

**解决**：升级服务器配置，或优化数据库连接（使用连接池、将数据库和应用部署在同一区域）

---

## 11. 更新升级

### 11.1 Vercel 部署的更新方式

Vercel 部署的更新非常简单：

1. **如果你是通过 Fork 部署的**：
   - 当原始仓库有更新时，你需要同步 Fork 仓库
   - 访问你 Fork 的仓库页面
   - 点击 **Sync fork**（同步分支）→ **Update branch**（更新分支）
   - 同步后，Vercel 会自动检测到代码变更并重新部署

2. **开启自动同步（可选）**：
   - 可以使用 [Pull](https://github.com/apps/pull) 等 GitHub App 自动同步 Fork
   - 安装后，每当上游仓库有更新，会自动提交 PR 或直接合并到你的 Fork

3. **手动推送更新**：
   - 如果你修改过代码，可以手动 `git pull` 上游仓库的更新后推送到你的 Fork
   - 推送后 Vercel 自动重新部署

4. **查看部署状态**：
   - 在 Vercel 控制台 → Deployments 查看最新部署
   - 等待状态变为 Ready（就绪）即更新完成

### 11.2 传统服务器部署的更新方式

```bash
# 1. 进入项目目录
cd /var/www/gitd

# 2. 备份当前版本（可选但推荐）
cp -r .env .env.backup
git log --oneline -5  # 记录当前版本号

# 3. 拉取最新代码
git pull origin main
# 如果你的主分支是 master，请使用 git pull origin master

# 4. 安装/更新依赖
npm install

# 5. 查看是否有数据库迁移需要执行
#    （参考版本更新说明，如果有数据库结构变更，需运行迁移脚本）
#    npm run migrate  # 如果项目支持

# 6. 重启服务
pm2 restart gitd

# 7. 验证服务正常
pm2 logs gitd --lines 20  # 查看最近日志
```

### 11.3 更新前注意事项

- **备份数据库**：每次更新前，建议备份数据库，防止数据丢失：
  ```bash
  # 备份数据库
  pg_dump -U gitd_user -h 127.0.0.1 gitd > gitd_backup_$(date +%Y%m%d).sql
  ```
- **查看更新日志**：更新前阅读版本的 Release Notes（更新说明），了解是否有破坏性变更（Breaking Changes）
- **选择合适时间**：建议在低峰期更新，避免影响用户使用

### 11.4 更新后验证

更新完成后，请验证以下内容：

1. 访问首页，确认页面正常加载
2. 登录系统，确认账号能正常登录
3. 查看已有项目列表，确认数据完整
4. 尝试一次小的部署操作，确认功能正常
5. 查看系统日志，确认无异常报错

### 11.5 回滚方案

如果更新后出现问题，可以回滚到之前的版本：

#### Vercel 部署回滚

1. 在 Vercel 控制台 → Deployments
2. 找到上一个正常工作的部署
3. 点击右侧菜单 → **Promote to Production**（提升到生产环境）
4. 系统会立即切换到该版本

#### 传统服务器部署回滚

```bash
# 1. 进入项目目录
cd /var/www/gitd

# 2. 回退到上一个版本（Git 回滚）
git log --oneline -10          # 查看历史版本
git checkout <上一个版本的commit哈希>  # 切换到旧版本

# 或使用 git reset
git reset --hard <上一个版本的commit哈希>

# 3. 重新安装依赖
npm install

# 4. 恢复数据库（如有必要）
psql -U gitd_user -h 127.0.0.1 gitd < gitd_backup_YYYYMMDD.sql

# 5. 重启服务
pm2 restart gitd
```

### 11.6 版本号说明

gitd 遵循语义化版本号（Semantic Versioning）：`主版本.次版本.修订号`

- **修订号**（如 1.2.**3** → 1.2.**4**）：Bug 修复，可直接更新
- **次版本**（如 1.**2**.3 → 1.**3**.0）：新增功能，向后兼容，一般可直接更新
- **主版本**（如 **1**.2.3 → **2**.0.0）：重大变更，可能不兼容，更新前请仔细阅读更新说明

---

## 附录：快速检查清单

部署完成后，请对照以下清单确认所有项目已完成：

- [ ] Node.js 22 已安装（传统部署）/ Vercel 账号已注册（Vercel 部署）
- [ ] PostgreSQL 数据库已创建，连接字符串已获取
- [ ] `POSTGRES_URL` 和 `DATABASE_URL` 环境变量已配置
- [ ] `JWT_SECRET` 已设置为随机字符串
- [ ] GitHub OAuth App 已创建，Client ID 和 Client Secret 已获取
- [ ] `GITHUB_OAUTH_CLIENT_ID` 和 `GITHUB_OAUTH_CLIENT_SECRET` 已配置
- [ ] OAuth App 的回调地址已正确设置为 `https://你的域名/api/auth/github/callback`
- [ ] ET Studio 授权码已从 [gitd.cn](https://gitd.cn) 获取
- [ ] `LICENSE_KEY` 和 `LICENSE_VERIFY_URL` 已配置
- [ ] 项目已成功部署并可访问
- [ ] `/install` 安装向导已完成（数据库初始化、管理员账号创建、授权验证）
- [ ] HTTPS 已配置（强烈推荐）
- [ ] 系统功能已验证正常

---

## 技术支持

如果在部署过程中遇到问题，可以通过以下方式获取帮助：

- 查看本文档第 10 节「常见问题」
- 在 GitHub 仓库提交 Issue
- 联系 ET Studio 官方支持：[https://gitd.cn](https://gitd.cn)

---

*本文档由 gitd 团队编写，最后更新日期：2026-07-31*
