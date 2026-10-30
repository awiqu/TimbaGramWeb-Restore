import { isPremiumForever } from '@timba/shared';
import { supportGuide } from './supportGuide.js';

/** -1 is an infinite balance */
const coins = (n: number) => (n === -1 ? '∞' : String(n));
/**
 * Тексты, которые формирует сервер: служебные сообщения в группах и сообщения об ошибках
 * (их пользователь видит во всплывающих уведомлениях).
 *
 * Надписи интерфейса — в client/src/strings.ts.
 * Тексты проверки полей (длина пароля, формат имени пользователя) — в shared/src/schemas.ts.
 */
export const txt = {
  /** Язык для дат в служебных сообщениях */
  locale: 'ru-RU',

  /** Пуш-уведомления о заявках на вступление */
  joinRequests: {
    newRequest: (who: string) => `${who} хочет вступить`,
    approvedTitle: 'Заявка принята',
    approved: (title: string) => `Вас приняли в «${title}»`,
  },

  /** Служебные сообщения в группах. who / whom — имена пользователей. */
  service: {
    created: (who: string, title: string) => `${who} создал(а) группу «${title}»`,
    added: (who: string, names: string) => `${who} добавил(а) ${names}`,
    renamed: (who: string, title: string) => `${who} изменил(а) название группы на «${title}»`,
    photoChanged: (who: string) => `${who} изменил(а) фото группы`,
    left: (who: string) => `${who} покинул(а) группу`,
    joined: (who: string) => `${who} вступил(а) в группу`,
    joinedByLink: (who: string) => `${who} вступил(а) в группу по ссылке`,
    requestApproved: (who: string, whom: string) => `${who} принял(а) заявку ${whom}`,
    kicked: (who: string, whom: string) => `${who} исключил(а) ${whom}`,
    banned: (who: string, whom: string, period: string) => `${who} заблокировал(а) ${whom} ${period}`,
    muted: (who: string, whom: string, period: string) => `${who} запретил(а) писать ${whom} ${period}`,
    unmuted: (who: string, whom: string) => `${who} снял(а) ограничения с ${whom}`,
    newOwner: (whom: string) => `${whom} теперь владелец группы`,
    pinned: (who: string, what: string) => `${who} закрепил(а) ${what}`,
    pinnedQuote: (text: string) => `«${text}»`,
    pinnedFallback: 'сообщение',
    forever: 'навсегда',
    until: (date: string) => `до ${date}`,
    // каналы: без имени того, кто сделал действие
    channelCreated: (title: string) => `Канал «${title}» создан`,
    channelRenamed: (title: string) => `Канал переименован в «${title}»`,
    channelPhotoChanged: 'Фото канала обновлено',
    channelPinned: (what: string) => `Закреплено ${what}`,
    pollStopped: (question: string) => `Опрос «${question}» завершён`,
    autoDeleteOn: (who: string, period: string) => `${who} установил(а) автоудаление сообщений через ${period}`,
    autoDeleteOff: (who: string) => `${who} выключил(а) автоудаление сообщений`,
    slowModeOn: (period: string) => `Включён медленный режим: одно сообщение в ${period}`,
    slowModeOff: 'Медленный режим выключен',
    period: (sec: number) =>
      sec >= 30 * 86400 ? '1 месяц' : sec >= 7 * 86400 ? '1 неделю' : sec >= 86400 ? '1 день' : sec >= 3600 ? '1 час' : sec >= 60 ? `${sec / 60} мин.` : `${sec} сек.`,
  },

  labels: {
    adminName: 'Администратор',
    savedMessages: 'Избранное',
    deletedAccount: 'Удалённый аккаунт',
    deletedMessage: 'Удалённое сообщение',
    media: 'Медиа',
    photo: 'Фото',
    video: 'Видео',
    voice: '🎤 Голосовое сообщение',
    round: '📹 Видеосообщение',
    pollPreview: (question: string) => `📊 ${question}`,
    sticker: (emoji: string) => `${emoji} Стикер`,
    transferPreview: (amount: number) => `💸 Перевод ${amount} ТК`,
    fundPreview: (title: string) => `💰 Сбор: ${title}`,
    checklistPreview: (title: string) => `☑️ ${title}`,
    fundTransfer: (title: string) => `Сбор «${title}»`,
    reminder: '⏰ Напоминание',
    incomingCall: (video: boolean) => (video ? '📹 Входящий видеозвонок' : '📞 Входящий звонок'),
    callLinkTitle: 'Звонок по ссылке',
    groupCallStarted: '📞 Групповой звонок начат',
    groupCallEnded: (duration: string) => `📞 Групповой звонок завершён, ${duration}`,
    callDone: (video: boolean, duration: string) => `${video ? '📹 Видеозвонок' : '📞 Звонок'}, ${duration}`,
    callMissed: (video: boolean) => (video ? '📹 Пропущенный видеозвонок' : '📞 Пропущенный звонок'),
    callDeclined: (video: boolean) => (video ? '📹 Отклонённый видеозвонок' : '📞 Отклонённый звонок'),
    reminderOf: (snapshot: string) => `⏰ Напоминание\n\n${snapshot}`,
    defaultMaintenance: 'Мессенджер временно недоступен. Попробуйте позже.',
    impersonationDevice: 'Вход администратора',
    clientNotBuilt: 'Клиент не собран. Запустите `npm run build` или используйте `npm run dev`.',
  },

  notifications: {
    /** заголовки push-уведомлений банка и поддержки */
    bankTitle: 'ТимбаКоины',
    supportTitle: 'Поддержка',
  },

  tickets: {
    notFound: 'Обращение не найдено',
    types: {
      problem: 'Проблема',
      question: 'Вопрос',
      payment: 'ТимбаКоины и оплата',
      suggestion: 'Предложение',
      complaint: 'Жалоба',
      other: 'Другое',
    } as Record<string, string>,
    operatorCalled: 'Вы позвали оператора. Он ответит здесь же — обычно в течение дня. Когда придёт ответ, вы получите уведомление.',
    reopened: 'Обращение снова открыто',
    pushSupport: 'Поддержка ответила на обращение',
    pushOperator: 'Оператор ответил на обращение',
    closed: 'Вы закрыли обращение',
    closedByOperator: 'Оператор закрыл обращение. Если вопрос остался, напишите сюда — обращение откроется снова.',
    fallback: (id: number) =>
      `Спасибо! Обращение №${id} зарегистрировано, мы ответим здесь же. Если вопрос срочный, нажмите «Позвать оператора» внизу.`,
    adminOperatorCall: (id: number, type: string, name: string, username: string, subject: string) =>
      `🙋 Обращение №${id} ждёт оператора\n${type} · ${name} (@${username})\n«${subject}»\n\nОтветить: Чаты → папка «Поддержка».`,
    adminNewTicket: (id: number, type: string, name: string, username: string, subject: string, operator: boolean) =>
      `📩 Новое обращение №${id}${operator ? ' — ждёт оператора' : ''}\n${type} · ${name} (@${username})\n«${subject}»\n\nОткрыть: Чаты → папка «Поддержка».`,
    operatorAuto: 'Обращение передано оператору. Он ответит здесь же — обычно в течение дня. Когда придёт ответ, вы получите уведомление.',
    pushAdmin: (id: number) => `Новое сообщение в обращении №${id}`,
    /** системный промпт поддержки; справочник — server/src/supportGuide.ts */
    prompt: (appName: string, name: string, type: string) =>
      `Ты — сотрудник службы поддержки мессенджера ${appName}. Ты живой человек из команды ${appName}. ` +
      `Никогда не говори, что ты искусственный интеллект, нейросеть, бот, языковая модель, GigaChat или программа, и не упоминай Сбер. ` +
      `Если спросят, человек ли ты, — отвечай, что ты сотрудник поддержки ${appName}. ` +
      `Пользователя зовут ${name}. Он создал обращение с типом «${type}». ` +
      `Отвечай по-русски, вежливо и по делу, без markdown-разметки (никаких звёздочек и решёток). ` +
      `Если нужно что-то сделать — дай короткую пошаговую инструкцию: каждый шаг с новой строки, начиная с цифры и точки. ` +
      `Отвечай только на основе справочника ниже. Не выдумывай кнопок, разделов и функций, которых в нём нет. ` +
      `Если вопроса нет в справочнике, советы не помогли или нужно действие администратора — честно скажи об этом и посоветуй нажать кнопку «Позвать оператора» внизу обращения. ` +
      `Если это предложение или идея — поблагодари и скажи, что передашь его команде. ` +
      `На вопросы не о ${appName} отвечай коротко, что поддержка помогает только с мессенджером.\n\nСПРАВОЧНИК\n${supportGuide(appName)}`,
  },

  /** /secret/blooms: страница по PIN-коду */
  secret: {
    wrongPassword: 'Неверный пароль',
    locked: 'Сначала введите пароль',
    tooBig: 'Сохранение слишком большое',
    noSave: 'Прогресс с таким кодом не найден',
  },

  gameSaves: {
    badKey: 'Некорректное имя сохранения игры',
    tooBig: 'Сохранение игры слишком большое',
    tooMany: 'Слишком много сохранений игр',
    noBackup: 'Такой копии прогресса нет',
    noGame: 'Такой игры нет в списке',
    noField: 'У этой игры нет такого поля',
    badValue: 'Это значение не подходит для поля',
  },

  leaderboard: {
    noGame: 'У этой игры нет рейтинга',
    badScore: 'Такой результат не принимается',
    premiumOnly: 'Результаты в рейтинг отправляют игроки с TimbaGram Premium',
    awardTitle: '🏆 Награда за рейтинг',
    awardBody: (caption: string) => `Вы получили награду: «${caption}»`,
    prizeOp: (place: number, caption: string) => `Рейтинг: ${place} место по ${caption}`,
    prizeTitle: '🏆 Награда за рейтинг',
    prizeBody: (place: number, caption: string, amount: number) => `${place} место в рейтинге по ${caption}: +${amount} ТК`,
  },

  pvp: {
    title: () => '🎮 Мультиплеер',
    premiumOnly: 'Вызывать на игру в «Мультиплеере» можно с TimbaGram Premium',
    self: 'Нельзя играть с самим собой',
    blocked: 'Этого пользователя нельзя вызвать на игру',
    alreadyPlaying: 'С этим игроком уже есть открытая игра',
    tooManyInvites: (n: number) => `Можно отправить не больше ${n} приглашений сразу`,
    noMoney: 'Не хватает ТК на такую ставку',
    notFound: 'Игра не найдена',
    notPending: 'Приглашение уже не действует',
    expired: 'Время приглашения вышло',
    notYours: 'Это не ваше приглашение',
    notActive: 'Игра уже закончилась',
    notYourTurn: 'Сейчас ход соперника',
    alreadyRolled: 'Вы уже бросили кость в этом раунде',
    alreadyPicked: 'Вы уже сделали выбор в этом раунде',
    badMove: 'Такого хода в этой игре нет',
    opponentNoMoney: 'У соперника больше не хватает ТК на ставку, приглашение отменено',
    creatorNoMoney: (name: string) => `${name} принял приглашение, но на ставку не хватило ваших ТК`,
    gameName: { duel: 'Дуэль', dice: 'Кости', tictactoe: 'Крестики-нолики', connect4: '4 в ряд', rps: 'Камень, ножницы, бумага', nim: 'Двадцать одна' } as Record<string, string>,
    opStake: (game: string, id: number) => `${txt.pvp.gameName[game]} №${id}: ставка`,
    opWin: (game: string, id: number) => `${txt.pvp.gameName[game]} №${id}: победа`,
    opDraw: (game: string, id: number) => `${txt.pvp.gameName[game]} №${id}: ничья, ставка возвращена`,
    invitePush: (name: string, game: string, stake: number) =>
      `${name} вызывает вас: ${txt.pvp.gameName[game]}. Ставка ${stake} ТК`,
    acceptedPush: (name: string, game: string, yourTurn: boolean) =>
      `${name} принял вызов${game === 'dice' ? '. Бросайте кость!' : game === 'rps' ? '. Делайте выбор!' : yourTurn ? '. Ваш ход!' : ', первым ходит соперник'}`,
    declinedPush: (name: string) => `${name} отказался от игры`,
    wonPush: (name: string, pot: number) => `Вы победили ${name} и забрали ${pot} ТК 🎉`,
    lostPush: (name: string, stake: number) => `Победил ${name}. Ставка ${stake} ТК ушла ему`,
    drawPush: (stake: number) => `Ничья! Ставка ${stake} ТК возвращена`,
    yourTurnPush: (name: string, action: string) => `${name} ${action}. Ваш ход!`,
    actionDone: { shoot: 'выстрелил и промахнулся', aim: 'прицелился', knock: 'сбил ваш прицел' } as Record<string, string>,
    markDone: 'сделал ход',
    dropDone: 'бросил фишку',
    addDone: (n: number, total: number) => `добавил ${n}, на счётчике ${total}`,
    pickedPush: (name: string) => `${name} уже выбрал. Ваш выбор!`,
    roundPush: (won: boolean, a: number, b: number, isCreator: boolean) =>
      `${won ? 'Вы выиграли раунд' : 'Раунд за соперником'}. Счёт ${isCreator ? a : b}:${isCreator ? b : a}. Делайте выбор!`,
    roundTiePush: 'Ничья в раунде. Выбирайте ещё раз!',
    rolledPush: (name: string, roll: number) => `${name} выбросил ${roll}. Ваш бросок!`,
    tiePush: (n: number) => `Ничья: у обоих ${n}. Бросайте ещё раз!`,
  },

  casino: {
    premiumOnly: 'Казино доступно только с TimbaGram Premium',
    slotsOp: (reels: string) => `Слоты ${reels}`,
    rouletteOp: (n: number) => `Рулетка: выпало ${n}`,
  },

  /** Значки, подписи под ником и награды, которые выдаёт админ */
  profile: {
    badgeNotFound: 'Значок не найден',
    tagNotFound: 'Подпись не найдена',
    awardNotFound: 'Награда не найдена',
    tooManyTags: (n: number) => `У человека может быть не больше ${n} подписей`,
    tooManyAwards: (n: number) => `У человека может быть не больше ${n} наград`,
    badDegree: 'Степень награды — от 1 до 8',
  },

  premium: {
    pending: 'Предыдущая оплата Премиума ещё проверяется',
    check: (name: string, username: string, price: number, phone: string | null) =>
      `⭐ Проверка оплаты TimbaGram Premium\n\n${name} (@${username}) оплатил ${price} ₽ ` +
      `${phone ? `переводом на номер +${phone}` : 'по ссылке для оплаты Премиума'}.\nВыдать Премиум на месяц?`,
    /** "до 28 октября 2026" or "бессрочно" */
    until: (ts: number) =>
      isPremiumForever(ts)
        ? 'бессрочно'
        : `до ${new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\.$/, '')}`,
    approved: (until: string) =>
      `⭐ Оплата подтверждена! TimbaGram Premium активен ${until}.\n\nТеперь у вас есть значок Премиума, игры в Профиле → «Игры» и увеличенный лимит загрузки файлов.`,
    rejected: (price: number) => `❌ Оплата Премиума на ${price} ₽ не найдена. Заявка отклонена.`,
    given: (until: string) => `⭐ Администратор выдал вам TimbaGram Premium ${until}.`,
    changed: (until: string) => `⭐ Администратор изменил срок TimbaGram Premium: теперь он активен ${until}.`,
    noDate: 'Выберите дату окончания',
    cutForever: 'Бессрочный Премиум нельзя сократить на дни: задайте дату окончания',
    promoExists: 'Такой промокод уже есть',
    promoNotFound: 'Промокод не найден или больше не действует',
    promoUsedUp: 'Этот промокод уже использовали максимальное число раз',
    promoAlready: 'Вы уже активировали этот промокод',
    promoIsCoins: 'Это промокод на ТимбаКоины: введите его в разделе «ТимбаКоины» → «Активировать промокод»',
    removed: 'TimbaGram Premium отключён администратором.',
    weeklyBonusOp: 'Еженедельный бонус Премиума',
    bonusNoPremium: 'Еженедельный бонус доступен только с TimbaGram Premium',
    bonusNotYet: 'Бонус уже получен на этой неделе',
    bonusReady: (amount: number) => `🎁 Ваш еженедельный бонус Премиума готов: ${amount} ТК ждут вас! Заберите его на странице TimbaGram Premium.`,
    bonusWaiting: (amount: number) => `⏰ Не забудьте забрать еженедельный бонус: ${amount} ТК всё ещё ждут вас на странице TimbaGram Premium.`,
    endsSoon: (until: string) =>
      `⌛ TimbaGram Premium закончится меньше чем через сутки (активен ${until}). Продлите его на странице Премиума, чтобы не потерять значок, игры и еженедельный бонус.`,
  },

  stickers: {
    premiumOnly: 'Свои стикерпаки можно создавать только с TimbaGram Premium',
    tooManyPacks: (max: number) => `Можно создать не больше ${max} стикерпаков`,
    packFull: (max: number) => `В паке уже ${max} стикеров — больше добавить нельзя`,
    packNotFound: 'Стикерпак не найден или удалён',
    stickerNotFound: 'Стикер не найден',
    notOwner: 'Изменять пак может только его автор',
    imageRequired: 'Для стикера нужна картинка',
    noSchedule: 'Стикер нельзя запланировать',
    notEditable: 'Стикер нельзя изменить',
  },

  bank: {
    banned: 'Ваш счёт ТимбаКоинов заблокирован',
    selfTransfer: 'Нельзя отправить ТимбаКоины самому себе',
    insufficient: 'Недостаточно средств на счёте',
    jokeNoMoney: 'Недостаточно ТимбаКоинов',
    promoNotFound: 'Промокод не найден или неактивен',
    promoExhausted: 'Промокод исчерпан',
    promoUsed: 'Вы уже использовали этот промокод',
    promoBankEmpty: 'Банк не может выдать награду — недостаточно средств',
    promoExists: 'Такой промокод уже существует',
    promoIsPremium: 'Это промокод на TimbaGram Premium: введите его на странице Премиума',
    accountNotFound: 'Счёт не найден',
    topupPending: 'Предыдущий перевод ещё проверяется',
    topupNotFound: 'Заявка не найдена',
    topupDecided: 'Заявка уже рассмотрена',
    topupCheck: (name: string, username: string, amount: number, phone: string) =>
      `💳 Проверка пополнения\n\n${name} (@${username}) перевёл ${amount} ₽ на номер +${phone}.\nЗачислить ${amount} ТК?`,
    topupCheckLink: (name: string, username: string, amount: number) =>
      `💳 Проверка пополнения\n\n${name} (@${username}) оплатил ${amount} ₽ по ссылке для пополнения.\nЗачислить ${amount} ТК?`,
    topupApproved: (amount: number, balance: number) => `✅ Пополнение подтверждено: +${amount} ТК.\n\n💰 Ваш новый баланс: ${coins(balance)} ТК.`,
    topupRejected: (amount: number) => `❌ Перевод на ${amount} ₽ не найден. Пополнение отклонено.`,
    incomeJoke: 'Анекдот',
    incomeAi: 'ЧатБот',
    closedAccount: (u: string) => `Счёт удалённого @${u}`,
    imported: 'Перенос баланса из прежней версии',
    welcome: (n: number) =>
      `💰 На ваш счёт зачислено ${n} ТимбаКоинов — это внутренняя валюта мессенджера.\nИх можно переводить друзьям, собирать на общие цели в чатах и тратить на покупки. Баланс и история — в Профиле → «ТимбаКоины».`,
    received: (amount: number, from: string, message: string, balance: number) =>
      `🎁 Вы получили ТимбаКоины!\n\n📥 Перевод ${amount} ТК от @${from}.` +
      (message ? `\n💬 Сообщение: «${message}»` : '') +
      `\n\n💰 Ваш новый баланс: ${coins(balance)} ТК.`,
    adminChange: (amount: number, reason: string, balance: number, set: boolean) =>
      (balance === -1
        ? '♾ Администратор сделал ваш баланс бесконечным'
        : set
          ? `⚡ Администратор установил баланс: ${balance} ТК`
          : `⚡ Начисление администратора: ${amount > 0 ? '+' : ''}${amount} ТК`) +
      (reason ? `\n💬 ${reason}` : '') +
      (balance === -1 || set ? '' : `\n\n💰 Баланс: ${balance} ТК.`),
    badBalance: 'Баланс не может быть меньше -1 (-1 — бесконечный)',
    infiniteOn: 'Бесконечный баланс',
  },

  /**
   * Боты. Тексты встроенных ботов — их можно менять в админ-панели («Надписи»), как и остальные.
   * В тексте можно использовать разметку сообщений: **жирный**, `код`. Токен бота выводится в `...`.
   */
  bots: {
    usernameReserved: 'Имена, оканчивающиеся на «bot», принадлежат только ботам: их создают в Профиле → Расширенные настройки → Боты',
    noCalls: 'Боту нельзя позвонить',
    noTransfers: 'Бот не принимает переводы ТК',
    deletedByAdmin: 'Бот удалён администратором',
    payMessage: (username: string) => `Создание бота @${username}`,
    buttonOutdated: 'Эта кнопка уже недействительна',
    builtinKept: 'Встроенных ботов удалить нельзя',
    creationOff: 'Создание ботов сейчас отключено администратором',
    botDisabled: 'бот отключён администратором',

    // ---------- касса и счета ----------
    paymentsOff: 'Платежи ботов отключены',
    invoiceNotFound: 'Счёт не найден',
    invoiceNotPending: 'Этот счёт уже нельзя оплатить',
    invoiceExpired: 'Срок оплаты счёта истёк',
    invoicePayButton: (amount: number) => `Оплатить ${amount} ТК`,
    invoiceHeader: (title: string) => `🧾 **Счёт: ${title}**`,
    invoiceStatus: {
      pending: (amount: number) => `К оплате: **${amount} ТК**`,
      paid: (amount: number) => `✅ Оплачено: ${amount} ТК`,
      cancelled: () => '🚫 Счёт отменён',
      refunded: (amount: number) => `↩️ Деньги возвращены: ${amount} ТК`,
      expired: () => '⌛ Срок оплаты истёк',
    } as Record<string, (amount: number) => string>,
    invoicePaid: (title: string, amount: number) => `Счёт «${title}» оплачен: ${amount} ТК`,
    ledgerPayment: (title: string) => `Оплата: ${title}`,
    refundNotice: (bot: string, amount: number, title: string) => `Бот @${bot} вернул вам ${amount} ТК за «${title}».`,
    payoutNotice: (bot: string, amount: number, comment: string) =>
      `Бот @${bot} отправил вам ${amount} ТК${comment ? `: ${comment}` : ''}.`,
    payoutMessage: (comment: string) => comment || 'Выплата от бота',
    refundMessage: (title: string) => `Возврат: ${title}`,
    withdrawMessage: (bot: string) => `Вывод из кассы @${bot}`,
    depositMessage: (bot: string) => `Касса @${bot}`,
    noFundsOnBot: 'На балансе бота не хватает ТК',
    amountBad: (max: number) => `Сумма — целое число от 1 до ${max} ТК`,
    notYourInvoice: 'Это чужой счёт',
    walletBanned: 'Счёт получателя заморожен',
    nothingToWithdraw: 'В кассе бота пусто',

    // ---------- управление ботами (Профиль → Расширенные настройки → Боты) ----------
    nameBad: 'Имя не подходит: нужно от 1 до 64 символов',
    usernameBad: 'Username: латинские буквы, цифры и _, от 3 до 32 символов, начинается с буквы',
    usernameNoBot: 'Username бота должен оканчиваться на «bot»',
    botLimit: (max: number) => `У вас уже ${max} ботов — это максимум. Удалите ненужного.`,
    botNotYours: 'Это не ваш бот',
    botBuiltinReadonly: 'Встроенного бота нельзя изменить',
    commandsWhyFormat: 'нужен формат «команда - описание»',
    commandsWhyName: 'в названии команды допустимы строчные латинские буквы, цифры и _ (до 32 символов)',
    commandsWhyDescription: 'описание — от 1 до 256 символов',
    commandsWhyTooMany: 'команд больше 100',
    commandsWhyDuplicate: 'такая команда уже есть в списке',
    commandsBad: (line: string, why: string) => `Команда «${line}»: ${why}`,
    descriptionTooLong: (max: number) => `Описание слишком длинное: до ${max} символов`,
    aboutTooLong: (max: number) => `Текст «О боте» слишком длинный: до ${max} символов`,
    notEnoughToCreate: (price: number, balance: number | string) => `Недостаточно ТК: бот стоит ${price} ТК, а на счёте ${balance}`,
    walletOwnerOnly: 'Выбрать кассу может создатель бота',

    // ---------- @WeatherBot ----------
    weather: {
      name: 'Погода',
      about: 'Прогноз погоды в вашем городе',
      description:
        'Присылаю прогноз погоды в любом городе: выберите его поиском по названию. Каждый день в удобное время, ' +
        'подробность и набор показателей настраиваются: /start. Чтобы получать погоду в группе, добавьте меня в неё.',
      commands: [
        'start - меню и настройки',
        'weather - погода на сегодня',
        'tomorrow - погода на завтра',
        'week - погода на неделю',
        'details - подробная погода',
        'city - выбрать город',
        'help - помощь',
      ].join('\n'),
      help: (time: string) =>
        '🌤 <b>Погода</b>\n' +
        `Присылаю прогноз для выбранного города. Каждый день, по умолчанию в ${time} по времени этого города.\n\n` +
        '/weather — погода на сегодня\n' +
        '/tomorrow — на завтра\n' +
        '/week — на неделю вперёд\n' +
        '/details — подробная погода с разбивкой по часам\n' +
        '/city — выбрать другой город\n' +
        '/settings — настройки рассылки (в личных сообщениях)\n\n' +
        'Чтобы получать погоду в группе, добавьте меня в неё. Настраивает группу тот, кто меня добавил: ' +
        'в личке со мной → «Мои группы». В группах на команды лучше отвечаю, когда я администратор.',
      unavailable: '⚠️ Не получилось узнать погоду: сервис прогнозов недоступен. Попробуйте позже.',
      statusOff: 'рассылка выключена',
      statusOn: (time: string, level: string) => `каждый день в ${time}, ${level}`,
      menuTitle: (city: string, status: string) => `🌤 <b>Погода — ${city}</b>\nВаша рассылка: ${status}.`,
      noCity: 'не выбран',
      cityFirst:
        '🏙 <b>Для начала выберите город.</b>\n' +
        'Напишите его название, например <code>Архангельск</code> или <code>Нижний Новгород</code>. ' +
        'Можно и маленький город или посёлок: добавьте область, если названий несколько.',
      cityPrompt: '🏙 Напишите название города, например <code>Казань</code>. Чтобы отменить, отправьте любую команду.',
      cityPick: 'Выберите город из списка. Нужного нет — напишите название ещё раз, точнее.',
      cityNotFound: (query: string) =>
        `Не нашёл город «${query}». Проверьте название и напишите ещё раз; если похожих городов много, добавьте область: «Никольское Вологодская».`,
      cityDone: (name: string) => `Город: ${name}`,
      cityLost: 'Список устарел, напишите название города ещё раз',
      cityNeeded: 'Сначала выберите город',
      btnCity: (name: string) => `🏙 Город: ${name}`,
      btnCityPick: '🏙 Выбрать город',
      btnToday: '🌤 Сегодня',
      btnTomorrow: '🌥 Завтра',
      btnWeek: '📅 Неделя',
      btnDetails: '🔎 Подробно',
      btnDetailsTomorrow: '🔎 Подробно на завтра',
      btnDetailsToday: '🔎 Подробно на сегодня',
      btnMenu: '🏠 Меню',
      btnMine: '⚙️ Рассылка мне в личку',
      btnGroups: (n: number) => `👥 Мои группы (${n})`,
      btnBack: '⬅️ Назад',
      btnEnabled: (mark: string) => `${mark} Рассылка включена`,
      btnTime: (time: string) => `⏰ Время рассылки: ${time}`,
      btnManualTime: '✏️ Ввести время вручную',
      btnSendNow: '📨 Прислать сейчас',
      btnUnlink: '🔗 Отключить группу',
      btnUnlinkYes: 'Да, отключить',
      btnUnlinkNo: 'Нет',
      groupsTitle: '👥 <b>Ваши группы</b>',
      groupsNone: 'У вас нет подключённых групп.\nДобавьте меня в группу — и она появится здесь.',
      settingsTarget: (title: string | null) => (title === null ? 'вам в личные сообщения' : `группа «${title}»`),
      settingsText: (target: string, city: string, status: string) =>
        `⚙️ <b>Рассылка: ${target}</b>\nГород: ${city}.\nСейчас: ${status}.\n\n` +
        '<b>Подробность</b>: «Кратко» — одна строка; «Стандарт» — по строке на каждый выбранный показатель; ' +
        '«Подробно» — ещё и разбивка по времени суток.\n' +
        'Ниже отметьте, какие показатели включать в сообщение. Время — по часам выбранного города.',
      unlinkAsk: (title: string) => `Отключить группу «${title}»? Я выйду из неё и перестану слать погоду.`,
      timePrompt: 'Пришлите время рассылки по времени вашего города, например <code>7:30</code>.',
      timeBad: 'Не похоже на время. Нажмите «Ввести время вручную» ещё раз и пришлите, например, 7:30.',
      timeDone: (time: string) => `Готово: рассылка в ${time}.`,
      sent: 'Отправлено',
      sendFailed: (why: string) => `Не удалось отправить: ${why}`,
      noAccess: 'Нет доступа или группа отключена',
      noAccessShort: 'Нет доступа',
      serviceDown: 'Сервис погоды недоступен, попробуйте позже',
      unlinked: 'Группа отключена',
      failed: 'Что-то пошло не так',
      groupSettingsHint: (who: string) => `Рассылкой группы и городом управляет тот, кто добавил меня${who}. В личных сообщениях со мной: /start → «Мои группы».`,
      groupManager: (name: string) => ` — это ${name}`,
      groupNoCity: (who: string) => `Для этой группы ещё не выбран город. Его выбирает тот, кто добавил меня${who}: в личных сообщениях со мной /start → «Мои группы».`,
      groupHello: (who: string) =>
        `Привет! Буду присылать сюда погоду каждый день. Сначала нужно выбрать город.${who || ' Город и рассылку настраивает тот, кто меня добавил: '}в личке со мной → «Мои группы». Команды: /weather, /tomorrow, /week, /details.`,
      groupManagerIs: (name: string) => ` Город и рассылку настраивает ${name}: `,
      managerNotice: (title: string) => `✅ Группа «${title}» подключена к рассылке погоды. Осталось выбрать город: нажмите кнопку и напишите его название. Позже: /start → «Мои группы».`,
    },

    // ---------- @PremiumBot ----------
    premiumbotName: 'TimbaGram Premium',
    premiumbotAbout: 'Продаёт Премиум за ТК',
    premiumbotDescription:
      'Здесь можно купить TimbaGram Premium за ТК: на 1 день, 7 дней или 30 дней. Нажмите /start, выберите срок и оплатите счёт.',
    premiumbotCommands: ['start - купить Премиум', 'help - что даёт Премиум'].join('\n'),
    premiumPerks:
      `Что даёт Премиум: значок у имени, игры в Профиле → «Игры», казино, дуэли в «Мультиплеере», ` +
      `свои стикерпаки, в 4 раза больше лимит загрузки файлов и еженедельный бонус в ТК.`,
    /** «1 день», «7 дней» */
    premiumDays: (d: number) => (d % 10 === 1 && d % 100 !== 11 ? `${d} день` : d % 10 >= 2 && d % 10 <= 4 && (d % 100 < 12 || d % 100 > 14) ? `${d} дня` : `${d} дней`),
    premiumMenu: (status: string, balance: number | string) =>
      `⭐ **TimbaGram Premium**\n\n${txt.bots.premiumPerks}\n\n` +
      `${status}\nНа вашем счёте: ${balance} ТК.\n\nВыберите срок — я выставлю счёт:`,
    premiumStatusOn: (until: string) => `Сейчас Премиум активен ${until}. Покупка продлит его.`,
    premiumStatusOff: 'Сейчас Премиума нет.',
    premiumButton: (days: number, price: number) => `${txt.bots.premiumDays(days)} — ${price} ТК`,
    premiumInvoiceTitle: (days: number) => `Премиум на ${txt.bots.premiumDays(days)}`,
    premiumInvoiceDescription: 'TimbaGram Premium: значок, игры, казино, больше места для файлов, еженедельный бонус',
    premiumInvoiceSent: 'Счёт выставлен: нажмите «Оплатить»',
    premiumForever: 'У вас уже бессрочный Премиум: покупать нечего.',
    premiumDone: (until: string) => `⭐ Оплата прошла! TimbaGram Premium активен ${until}. Спасибо!`,
    premiumPaymentMessage: (days: number) => `Премиум на ${txt.bots.premiumDays(days)}`,
    premiumUnknown: 'Выберите срок Премиума кнопкой под сообщением. Чтобы показать кнопки снова, отправьте /start.',
  },

  /** Выгрузка переписки в текстовый файл */
  export: {
    header: (title: string, when: string, count: number) => `Переписка «${title}», выгружено ${when}, сообщений: ${count}`,
    replyTo: (text: string) => `↩ «${text}»`,
    edited: '(изменено)',
  },

  errors: {
    // общие
    notFound: 'Не найдено',
    forbidden: 'Недостаточно прав',
    unauthorized: 'Требуется вход',
    internal: 'Внутренняя ошибка сервера',
    invalidData: 'Некорректные данные',
    invalidId: 'Некорректный id',
    rateLimited: 'Слишком много попыток. Подождите немного.',
    // аккаунт
    banned: 'Ваш аккаунт заблокирован',
    deviceBanned: 'Доступ к TimbaGram с этого устройства закрыт',
    deviceNotFound: 'Устройство не найдено',
    adminOnly: 'Только для администратора',
    registrationClosed: 'Регистрация закрыта',
    usernameTaken: 'Это имя пользователя уже занято',
    phoneTaken: 'Этот номер телефона уже привязан к другому аккаунту',
    invalidCredentials: 'Неверное имя пользователя или пароль',
    adminUsernameLocked: 'Имя пользователя администратора изменить нельзя',
    wrongPassword: 'Неверный текущий пароль',
    sessionNotFound: 'Сеанс не найден',
    userNotFound: 'Пользователь не найден',
    cannotBanAdmin: 'Нельзя заблокировать администратора',
    cannotTouchAdmin: 'Это действие недоступно для аккаунта администратора',
    notImpersonating: 'Вы не входили под чужим аккаунтом',
    accountsLimit: (n: number) => `Можно добавить не больше ${n} аккаунтов`,
    accountsImpersonating: 'Недоступно, пока вы вошли под чужим аккаунтом',
    accountNotFound: 'Аккаунт не найден. Войдите в него заново.',
    groupCreationOff: 'Создание групп отключено администратором',
    channelCreationOff: 'Создание каналов отключено администратором',
    uploadsOff: 'Загрузка файлов отключена администратором',
    supportTextOnly: 'В поддержку можно отправлять только текст',
    fundNotFound: 'Сбор не найден',
    fundClosed: 'Сбор уже закрыт',
    checklistNotFound: 'Список не найден',
    checklistLocked: 'Добавлять пункты может только автор списка',
    checklistFull: 'В списке уже максимум пунктов',
    reminderTime: 'Выберите время в будущем (до года вперёд)',
    transcribeUnavailable: 'Расшифровка сейчас недоступна',
    transcribeFailed: 'Не удалось расшифровать сообщение',
    transcribeKind: 'Расшифровать можно только голосовые и видеосообщения',
    slowMode: (sec: number) => `Включён медленный режим. Следующее сообщение можно отправить через ${sec >= 60 ? `${Math.ceil(sec / 60)} мин.` : `${sec} с`}`,
    scheduleTime: 'Выберите время в будущем (до года вперёд)',
    scheduledNotFound: 'Отложенное сообщение не найдено',
    scheduledThread: 'Комментарии нельзя отложить',
    // чаты и группы
    chatNotFound: 'Чат не найден',
    noAccess: 'Нет доступа к этому чату',
    groupsOnly: 'Доступно только в группах',
    privateOnly: 'Доступно только в личных чатах',
    notAGroup: 'Это не группа',
    publicLinkRequired: 'Для публичной группы нужна ссылка (@имя)',
    linkTaken: 'Эта ссылка уже занята',
    onlyOwnerCanDelete: 'Удалить группу может только владелец',
    notInGroup: 'Вы не состоите в группе',
    notMember: 'Сначала вступите в чат',
    privateGroup: 'Группа приватная — нужна пригласительная ссылка',
    bannedInGroup: 'Вы заблокированы в этой группе',
    invalidInvite: 'Ссылка недействительна',
    inviteExpired: 'Срок действия ссылки истёк или на неё уже вступило максимальное число людей',
    requestNotFound: 'Заявка не найдена: её уже рассмотрели или отозвали',
    statsForbidden: 'Статистика доступна только администраторам',
    tooManyInvites: (n: number) => `Можно создать не больше ${n} ссылок`,
    cannotInvite: 'Нет права добавлять участников',
    memberNotFound: 'Участник не найден',
    cannotEditRights: 'Нельзя изменить права этого участника',
    ownerRightsViaTransfer: 'Права владельца меняются только передачей владения',
    cannotKick: 'Нельзя исключить этого участника',
    cannotBan: 'Нельзя заблокировать этого участника',
    cannotMute: 'Нельзя ограничить этого участника',
    onlyOwnerCanTransfer: 'Только владелец может передать права',
    notAChannel: 'Это не канал',
    membersHidden: 'Список подписчиков видят только администраторы канала',
    privateChannel: 'Канал приватный — нужна пригласительная ссылка',
    bannedInChannel: 'Вы заблокированы в этом канале',
    youBlocked: 'Вы заблокировали этого пользователя. Разблокируйте, чтобы написать.',
    blockedByUser: 'Пользователь ограничил круг лиц, которые могут ему писать',
    cannotBlockSelf: 'Нельзя заблокировать себя',
    cannotContactSelf: 'Себя в контакты добавлять не нужно',
    cannotContactBot: 'Боты не добавляются в контакты: они в списке чатов',
    callUnavailable: 'Этому пользователю нельзя позвонить',
    callBusy: 'Пользователь сейчас разговаривает',
    groupCallNotMember: 'Звонить в группе могут только её участники',
    groupCallFull: (n: number) => `В звонке уже ${n} участников — это максимум`,
    callLinkInvalid: 'Ссылка на звонок недействительна',
    callYouBusy: 'Сначала завершите текущий звонок',
    callOffline: 'Пользователь не в сети и не включил уведомления',
    tooManyPinned: (n: number) => `Закрепить можно не больше ${n} чатов`,
    notPinned: 'Эти чаты не закреплены',
    tooManyFolders: (n: number) => `Можно создать не больше ${n} папок`,
    folderNotFound: 'Папка не найдена',
    readersUnavailable: 'Список прочитавших недоступен для этого сообщения',
    commentsOff: 'Комментарии к этому посту закрыты',
    subscribeToComment: 'Подпишитесь на канал, чтобы комментировать',
    // реакции
    reactionsOff: 'Реакции в этом чате выключены',
    reactionsAnonymous: 'Реакции на посты канала анонимные',
    // опросы
    pollsForbidden: 'Отправка опросов в этом чате запрещена',
    pollNotFound: 'Опрос не найден',
    pollClosed: 'Опрос уже завершён',
    quizOneAnswer: 'В викторине можно выбрать только один ответ',
    quizNoRetract: 'Ответ в викторине нельзя отменить',
    pollSingleAnswer: 'В этом опросе можно выбрать только один ответ',
    pollBadOption: 'Такого варианта нет',
    pollAnonymous: 'Опрос анонимный',
    cannotStopPoll: 'Остановить опрос может только его автор или администратор',
    cannotEditPoll: 'Опрос нельзя изменить',
    // сообщения
    cannotWrite: 'Вы не можете писать в этот чат',
    cannotWriteMuted: 'Вам запрещено писать в этот чат',
    mediaForbidden: 'Отправка медиа запрещена',
    messageNotFound: 'Сообщение не найдено',
    cannotEditMessage: 'Нельзя изменить это сообщение',
    emptyMessage: 'Сообщение не может быть пустым',
    cannotDeleteForAll: 'Нельзя удалить чужое сообщение у всех',
    cannotPin: 'Нет права закреплять сообщения',
    // файлы
    fileNotFound: 'Файл не найден',
    noFile: 'Файл не передан',
    fileTooLarge: 'Файл слишком большой',
    fileLargerThan: (mb: number) => `Файл больше ${mb} МБ`,
    imageRequired: 'Нужно загрузить изображение',
  },
};
