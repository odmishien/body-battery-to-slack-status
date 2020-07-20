import puppeteer from 'puppeteer';
import request from 'request-promise';

function sleep<T>(msec: number): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, msec));
}
function last<T>(arg: T[]): T {
  return arg[arg.length - 1];
}

type Metrics = Array<[number, number]>;
interface Values {
  stress: { stressValuesArray: Metrics; bodyBatteryValuesArray: Metrics };
  heartRate: { heartRateValues: Metrics };
}

class StatusUpdator {
  slackLegacyToken: string;
  lineNotifyToken: string;
  lastTimeStampSentBodyBatteryAlert: Date;
  hasSentBodyBatteryAlertToday: boolean;
  emojis: string | undefined;
  constructor(args: {
    slackLegacyToken: string;
    lineNotifyToken: string;
    emojis: string | undefined;
  }) {
    this.slackLegacyToken = args.slackLegacyToken;
    this.lineNotifyToken = args.lineNotifyToken;
    this.lastTimeStampSentBodyBatteryAlert = new Date();
    this.hasSentBodyBatteryAlertToday = false;
    this.emojis = args.emojis;
  }

  async update(values: Values) {
    const emoji = this.formatEmoji(values);
    const message = this.formatStatus(values);

    console.log(`Set Slack Status. emoji: ${emoji}, message: ${message}`);

    const res = await request('https://slack.com/api/users.profile.set', {
      method: 'POST',
      form: {
        token: this.slackLegacyToken,
        profile: JSON.stringify({
          status_emoji: emoji,
          status_text: message,
        }),
      },
      json: true,
    });

    if (!res.ok) {
      throw new Error(JSON.stringify(res));
    }
  }

  async lineNotify(values: Values) {
    this.resetHasSentBodyBatteryAlertToday();
    const message = this.getMessageForLine(
      values,
      this.hasSentBodyBatteryAlertToday
    );
    if (message) {
      console.log(`Send Line Notify. message: ${message}`);
      const res = await request('https://notify-api.line.me/api/notify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.lineNotifyToken}`,
        },
        formData: { message: message },
        json: true,
      });
      if (res.status !== 200) {
        throw new Error(JSON.stringify(res));
      }
    }
  }

  getMessageForLine(
    args: Values,
    hasSentBodyBatteryAlertToday: boolean
  ): string {
    const stress = last(last(args.stress.stressValuesArray));
    const bodyBattery = last(last(args.stress.bodyBatteryValuesArray));
    let message = '';
    if (Number(stress) > 51 && Number(stress) < 76) {
      message += `\n😥中ストレス状態です(ストレス値:${stress})`;
    }

    if (Number(stress) > 75) {
      message += `\n😰高ストレス状態です(ストレス値:${stress})`;
    }

    if (Number(bodyBattery) < 10 && hasSentBodyBatteryAlertToday) {
      message += `\n🔋ボディバッテリーが10を切りました`;
      this.hasSentBodyBatteryAlertToday = true;
      this.lastTimeStampSentBodyBatteryAlert = new Date();
    }

    return message;
  }

  resetHasSentBodyBatteryAlertToday() {
    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth();
    const nowDate = now.getDate();
    const lastSentBodyBatteryYear = this.lastTimeStampSentBodyBatteryAlert.getFullYear();
    const lastSentBodyBatteryMonth = this.lastTimeStampSentBodyBatteryAlert.getMonth();
    const lastSentBodyBatteryDate = this.lastTimeStampSentBodyBatteryAlert.getDate();
    if (
      nowYear !== lastSentBodyBatteryYear ||
      nowMonth !== lastSentBodyBatteryMonth ||
      nowDate !== lastSentBodyBatteryDate
    ) {
      this.hasSentBodyBatteryAlertToday = false;
    }
  }

  formatEmoji(args: Values): string {
    const emojis = this.emojis || this.defaultEmojis;
    const emojiItems = emojis
      .split(/:|\s+/)
      .filter((s) => s)
      .map((s) => `:${s}:`);
    const bodyBattery = last(last(args.stress.bodyBatteryValuesArray));
    const bodyBatteryMax = 100;
    const emoji =
      emojiItems[
        Math.floor((bodyBattery / bodyBatteryMax) * emojiItems.length)
      ];
    return emoji;
  }

  formatStatus(args: Values): string {
    const stress = last(last(args.stress.stressValuesArray));
    const bodyBattery = last(last(args.stress.bodyBatteryValuesArray));
    const heartRate = last(last(args.heartRate.heartRateValues));

    return `🔋${bodyBattery} 🧠${stress} 💗${heartRate}`;
  }

  private get defaultEmojis(): string {
    return 'weary confounded persevere disappointed slightly_smiling_face wink sweat_smile smiley laughing star-struck';
  }
}

class AuthInfo {
  mailAddress: string;
  password: string;
  slackLegacyToken: string;
  lineNotifyToken: string;
  emojis: string | undefined;
  constructor(
    mailAddress: string,
    password: string,
    slackLegacyToken: string,
    lineNotifyToken: string,
    emojis: string | undefined
  ) {
    this.mailAddress = mailAddress;
    this.password = password;
    this.slackLegacyToken = slackLegacyToken;
    this.lineNotifyToken = lineNotifyToken;
    this.emojis = emojis;
  }
  static newFromEnv(): AuthInfo {
    const MAIL_ADDRESS = process.env['GARMIN_MAIL_ADDRESS'];
    if (!MAIL_ADDRESS) {
      throw new Error('Please set GARMIN_MAIL_ADDRESS');
    }
    const PASSWORD = process.env['GARMIN_PASSWORD'];
    if (!PASSWORD) {
      throw new Error('Please set GARMIN_PASSWORD');
    }
    const SLACK_LEGACY_TOKEN = process.env['SLACK_LEGACY_TOKEN'];
    if (!SLACK_LEGACY_TOKEN) {
      throw new Error('Please set SLACK_LEGACY_TOKEN');
    }
    const LINE_NOTIFY_TOKEN = process.env['LINE_NOTIFY_TOKEN'];
    if (!LINE_NOTIFY_TOKEN) {
      throw new Error('Please set LINE_NOTIFY_TOKEN');
    }
    return new AuthInfo(
      MAIL_ADDRESS,
      PASSWORD,
      SLACK_LEGACY_TOKEN,
      LINE_NOTIFY_TOKEN,
      process.env['EMOJIS']
    );
  }
}

class Crawler {
  private authInfo: AuthInfo;
  private browser?: puppeteer.Browser;
  private page?: puppeteer.Page;
  loggedIn: boolean;
  constructor(authInfo: AuthInfo) {
    this.authInfo = authInfo;
    this.loggedIn = false;
  }
  private async getPage(): Promise<puppeteer.Page> {
    if (!this.page) {
      this.browser = await puppeteer.launch({
        headless: !process.env['DEBUG'],
      });
      this.page = await this.browser.newPage();
    }
    return this.page;
  }
  async login() {
    console.log('Login to Garmin Connect');
    const page = await this.getPage();
    const url = 'https://connect.garmin.com/signin/';
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector('iframe.gauth-iframe');

    const frame = page.frames().find((f) => f.url().match(/sso/));
    if (!frame) {
      throw new Error('Login form not found');
    }
    await frame.waitForSelector('input#username');
    await frame.type('input#username', this.authInfo.mailAddress);
    await frame.type('input#password', this.authInfo.password);
    await frame.click('#login-btn-signin');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });
    this.loggedIn = true;
  }
  async getLatestValues(): Promise<Values> {
    const page = await this.getPage();
    const today = new Date().toISOString().substr(0, 10);
    await page.goto(
      `https://connect.garmin.com/modern/proxy/wellness-service/wellness/dailyStress/${today}`
    );
    const stress = JSON.parse(
      (await page.evaluate(() => document.body.textContent)) || 'null'
    );
    await page.goto(
      `https://connect.garmin.com/modern/proxy/wellness-service/wellness/dailyHeartRate/?date=${today}`
    );
    const heartRate = JSON.parse(
      (await page.evaluate(() => document.body.textContent)) || 'null'
    );
    return { stress, heartRate };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

const main = async () => {
  const auth = AuthInfo.newFromEnv();
  let crawler = new Crawler(auth);
  const su = new StatusUpdator(auth);

  if (process.env['CI']) {
    // run once
    try {
      await crawler.login();
      const status = await crawler.getLatestValues();
      await su.update(status);
      await su.lineNotify(status);
      process.exit(0);
    } catch (error) {
      console.warn(error);
      process.exit(1);
    }
  } else {
    // daemon mode
    while (true) {
      try {
        console.log('Crawling');
        if (!crawler.loggedIn) await crawler.login();
        const status = await crawler.getLatestValues();
        await su.update(status);
        await su.lineNotify(status);
      } catch (error) {
        console.warn(error);
        crawler.close();
        crawler = new Crawler(auth);
      }
      console.log('Sleep');
      await sleep(60 * 60 * 1000); // sleep 60 min
    }
  }
};

main();
